"""Development-only reference comparison; never opens sealed independent data.

Requires the existing colorcheck Python environment (numpy/Pillow/OpenCV).
Usage: color-review-teachers.py --repo <checkout> --work <private-outside-repo>
The work directory contains data/teachers and data/teachers2, each with the
existing manifest/inputs/lr-export structure. Full rows and images stay private;
only teacher-summary-sanitized.json contains the anonymous aggregate report.
"""
import argparse, concurrent.futures, hashlib, json, subprocess, sys, time
from pathlib import Path

def digest(p):
    with open(p, 'rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()

def run_job(job):
    repo, work, cohort, scene, variant, engine = map(str, job)
    repo, work = Path(repo), Path(work)
    root = work/'data'/cohort
    source = root/'inputs'/f'{scene}__neutral.jpg'
    reference = root/'lr-export'/f'{scene}__{variant}.jpg'
    destination = work/'renders'/engine/cohort/f'{scene}__{variant}.png'
    destination.parent.mkdir(parents=True, exist_ok=True)
    settings = work/'settings'/f'{variant}-{"niho-6" if engine == "analytic-hs" else engine}.json'
    binary = repo/'packages/develop-engine/target/release/niho-develop-render'
    if not destination.exists() and engine == 'analytic-hs':
        probe_dir = destination.with_suffix('.probe')
        probe = repo/'packages/develop-engine/target/release/examples/analytic_hs_probe'
        r = subprocess.run([str(probe),str(source),str(settings),str(probe_dir)],capture_output=True,text=True)
        if r.returncode: raise RuntimeError(f'analytic probe failed status={r.returncode}')
        destination.write_bytes((probe_dir/'candidate-b-analytic-hs.png').read_bytes())
    if not destination.exists():
        r = subprocess.run([str(binary), 'render', '--settings', str(settings), '--out', str(destination), '--raster', str(source), '--max-dimension', '2048'], capture_output=True, text=True)
        if r.returncode: raise RuntimeError(f'render failed engine={engine}, status={r.returncode}')
    sys.path.insert(0, str(repo/'packages/develop-engine/tools/colorcheck'))
    from colorcheck.compare import run_compare
    result = run_compare(str(reference), str(destination), size=1500, blur=2, do_align=True)
    d = result['metrics']['deltaE00']
    return {'cohort':cohort, 'scene':scene, 'variant':variant, 'engine':engine, 'mean':d['mean'], 'p99':d['p99'], 'max':d['max'], 'flatFraction':result['metrics']['flatFraction'], 'inputSha256':digest(source), 'referenceSha256':digest(reference), 'candidateSha256':digest(destination)}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--repo',required=True,type=Path);ap.add_argument('--work',required=True,type=Path);ap.add_argument('--engines',default='niho-6,niho-8,analytic-hs');ap.add_argument('--workers',default=4,type=int)
    args=ap.parse_args();
    if args.work.resolve() == args.repo.resolve() or args.repo.resolve() in args.work.resolve().parents:
        raise SystemExit('Private inputs/outputs must be outside the repository')
    engines=args.engines.split(','); variants=['neutral','preset_bluesky2','preset_pastel','preset_colorful']
    args.work.mkdir(parents=True,exist_ok=True); settings_root=args.work/'settings';settings_root.mkdir(exist_ok=True)
    # Generate the preset settings through the existing public preset converter.
    example=args.repo/'packages/develop-engine/target/release/examples/render_rgba'
    public_input=args.repo/'packages/develop-engine/fixtures/golden/input/saturated-blue.png'
    for variant in variants:
        base=settings_root/f'{variant}-base.json'
        if not base.exists():
            spec='neutral' if variant=='neutral' else 'niho-'+variant.removeprefix('preset_')
            subprocess.run([str(example),str(public_input),spec,'32',str(settings_root/'scratch.rgba'),str(base)],check=True,capture_output=True)
        value=json.loads(base.read_text());value['look']='niho-standard-1'
        for engine in [e for e in engines if e != 'analytic-hs']:
            value['engine']=engine
            (settings_root/f'{variant}-{engine}.json').write_text(json.dumps(value))
    sys.path.insert(0,str(args.repo/'packages/develop-engine/tools/calibrate'))
    from fit_niho6_response import blank_input
    jobs=[];skipped=0;counts={};manifest_hashes=[];analytic_scenes=0
    for cohort in ['teachers','teachers2']:
        root=args.work/'data'/cohort; mp=root/'manifest.json';manifest=json.loads(mp.read_text())
        if manifest.get('sealed'): raise RuntimeError('sealed cohort is forbidden for this development runner')
        manifest_hashes.append(digest(mp));n=0
        # Metadata-only development subset: low, middle, high ISO per cohort.
        ordered=sorted(manifest['scenes'],key=lambda s: (float(s.get('iso') or 0),s['scene']))
        subset={ordered[i]['scene'] for i in (0,len(ordered)//2,len(ordered)-1)}
        for scene in manifest['scenes']:
            name=scene['scene']
            if blank_input(root/'inputs'/f'{name}__neutral.jpg'): skipped+=1;continue
            n+=1
            if name in subset: analytic_scenes+=1
            for variant in variants:
                for engine in engines:
                    if engine=='analytic-hs' and name not in subset: continue
                    jobs.append((args.repo,args.work,cohort,name,variant,engine))
        counts[cohort]=n
    start=time.monotonic()
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as pool:
        rows=list(pool.map(run_job,jobs))
    (args.work/'teacher-rows-private.json').write_text(json.dumps(rows,indent=2))
    summary=[]
    for engine in engines:
        for variant in variants:
            r=[x for x in rows if x['engine']==engine and x['variant']==variant]
            summary.append({'engine':engine,'variant':variant,'scenes':len(r),'mean':sum(x['mean'] for x in r)/len(r),'p99Mean':sum(x['p99'] for x in r)/len(r),'p99Max':max(x['p99'] for x in r),'p99Over8':sum(x['p99']>8 for x in r)})
    baseline={ (x['cohort'],x['scene'],x['variant']):x for x in rows if x['engine']==engines[0] }
    comparisons=[]
    for engine in engines[1:]:
        r=[x for x in rows if x['engine']==engine]
        comparisons.append({'engine':engine,'baseline':engines[0],'meanRegressions':sum(x['mean']>baseline[x['cohort'],x['scene'],x['variant']]['mean'] for x in r),'p99Regressions':sum(x['p99']>baseline[x['cohort'],x['scene'],x['variant']]['p99'] for x in r),'maxMeanIncrease':max(x['mean']-baseline[x['cohort'],x['scene'],x['variant']]['mean'] for x in r),'maxP99Increase':max(x['p99']-baseline[x['cohort'],x['scene'],x['variant']]['p99'] for x in r)})
    commit=subprocess.check_output(['git','-C',str(args.repo),'rev-parse','HEAD'],text=True).strip()
    result={'kind':'development-teachers-not-independent','commit':commit,'rendererSha256':digest(args.repo/'packages/develop-engine/target/release/niho-develop-render'),'manifestSha256':manifest_hashes,'cohortCounts':counts,'analyticSubsetScenes':analytic_scenes,'analyticSubsetSelection':'metadata-only low/median/high ISO per teacher cohort','blankExcluded':skipped,'independentImagesRead':0,'protocol':{'renderLongEdge':2048,'compareLongEdge':1500,'blur':2,'flatPixels':True,'alignment':True},'summary':summary,'comparisons':comparisons,'seconds':time.monotonic()-start}
    (args.work/'teacher-summary-sanitized.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__': main()
