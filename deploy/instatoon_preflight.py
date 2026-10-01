"""Offline smoke check of the exact comic runtime staged for deployment."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile


def module(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def check(root, pipeline_path):
    from PIL import Image, ImageDraw
    root = root.resolve()
    library = json.loads((root / 'bible/prompt-library.json').read_text())
    if library.get('presentation') != 'comic-v1':
        raise ValueError('Comic presentation contract is not enabled')
    pipeline = module(pipeline_path)
    renderer = module(root / 'scripts/render_episode.py')
    director = module(root / 'scripts/comic_presentation.py')
    if library.get('lettering') == 'planned-pen-v1':
        geometry=module(root/'scripts/lettering_geometry.py')
    cast = pipeline.load_cast_library(root, library)
    if not cast or not (root / library['style_reference']).is_file():
        raise ValueError('Approved original references are missing')
    for font in ('Pretendard-Bold','Pretendard-SemiBold','BMKIRANGHAERANG-OTF'):
        renderer.load_font(font, 48)
    display = {'kind':'narration','integrated_art':True,'text':'같은 이야기라도\n장면과 표정은 자연스럽게.'}
    plan = {'presentation':{'cover':{'title_lines':['우리 사이','작은 이야기'],'source_panel':0,'dedicated_art':True},
                            'panels':[display]}}
    with tempfile.TemporaryDirectory(prefix='toon-preflight-') as directory:
        folder=Path(directory)
        image=Image.new('RGB',(1080,1350),'white')
        ImageDraw.Draw(image).rectangle((60,60,1020,320),outline='black',width=3)
        image.save(folder/'art-0.png')
        Image.new('RGB',(1080,1350),'white').save(folder/'cover-art.png')
        display['bubble_boxes']=director.refine_bubble_boxes(folder/'art-0.png',
            [{'x':100,'y':100,'width':850,'height':180}],rectangular=True)
        layout=director.layout(plan)
        if layout['cards'][0]['art_bounds'] != {'x':0,'y':0,'width':1080,'height':1350}:
            raise ValueError('Narration still uses a cropped inset layout')
        renderer.render_card(layout['cards'][0],layout,folder,None)
        renderer.validate_clear_text_art(layout['cover'],layout,folder)
        renderer.render_card(layout['cover'],layout,folder,None)
        dialogue={'kind':'dialogue','integrated_art':True,'integrated_caption':True,
                  'caption':'쿠키를 건넸다.','speech':[{'speaker':'a','side':'right','text':'고마워!'}]}
        page=Image.new('RGB',(1080,1350),'white');draw=ImageDraw.Draw(page)
        draw.rectangle((60,60,800,260),outline='black',width=3)
        draw.ellipse((500,450,1000,750),outline='black',width=3)
        page.save(folder/'art-1.png')
        dialogue['caption_box']=director.refine_bubble_boxes(folder/'art-1.png',
            [{'x':100,'y':100,'width':640,'height':120}],rectangular=True)[0]
        dialogue['bubble_boxes']=director.refine_bubble_boxes(folder/'art-1.png',
            [{'x':600,'y':520,'width':300,'height':150}])
        plan['presentation']['panels'].append(dialogue)
        mixed=director.layout(plan)
        renderer.render_card(mixed['cards'][1],mixed,folder,None)
        if mixed['cards'][1]['art_bounds'] != {'x':0,'y':0,'width':1080,'height':1350}:
            raise ValueError('Dialogue caption still uses an inset')
        if library.get('lettering') == 'planned-pen-v1':
            for index,display in enumerate(plan['presentation']['panels']):
                director.prepare_lettering(display,index)
                director.render_lettering_guide(display,index,folder/f'layout-guide-{index}.png')
                Image.new('RGB',(896,1152),'#EEF0F1').save(folder/f'art-{index}.png')
            for index,display in enumerate(plan['presentation']['panels']):
                speakers=[item['speaker'] for item in display.get('speech',[])]
                observed={'people':[{'id':speaker,'head':{'x':650,'y':450,'width':250,'height':280},
                                     'mouth':{'x':760,'y':650}} for speaker in speakers],'protected':[]}
                director.resolve_lettering(display,index,observed,speakers)
            source_hashes={card:hashlib.sha256((folder/f'art-{card}.png').read_bytes()).hexdigest() for card in (0,1)}
            planned=director.layout(plan)
            for card in planned['cards']:
                renderer.render_card(card,planned,folder,None)
                if card.get('art_fit') != 'full-page':raise ValueError('Planned art lost its full-page contract')
                for layer in card['layers']:
                    fit=renderer.fit_text(layer,tuple(layer[k] for k in ('x','y','width','height')),planned['fonts'])
                    if fit['size']<40:raise ValueError('Planned lettering became unreadable')
            if any(hashlib.sha256((folder/f'art-{i}.png').read_bytes()).hexdigest()!=v for i,v in source_hashes.items()):
                raise ValueError('Lettering modified source artwork')
            Image.new('RGB',(1080,1350),'#F5E9D6').save(folder/'palette-probe.png')
            palette=geometry.audit_face_palette(folder/'palette-probe.png',observed,
                [{'id':speaker,'design':'White uncolored skin'} for speaker in speakers])
            if not palette['checked_faces'] or palette['pass']:
                raise ValueError('Peach skin drift was not detected')
        for name in ('card-0.png','card-1.png','cover.png'):
            with Image.open(folder/name) as output:
                if output.size != (1080,1350):raise ValueError('Unexpected page size')
    return {'pass':True,'version':library['version'],'cast_references':len(cast),
            'pipeline_sha256':hashlib.sha256(pipeline_path.read_bytes()).hexdigest(),
            'checks':['original-reference-hashes','fonts','rectangular-narration','dialogue-caption-rectangle','full-page-layout','cover-title-clearance','actual-render']
                     + (['premeasured-pen-lettering','layout-guides','uncropped-page-edges','speaker-tail-geometry','source-bytes-preserved','warm-skin-fill-detection'] if library.get('lettering') == 'planned-pen-v1' else []),
            'model_calls':0,'publish_calls':0}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--pipeline',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(check(args.root,args.pipeline),ensure_ascii=False))
