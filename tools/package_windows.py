"""Package current checkout only. --verify refuses stale BUILD_MANIFEST hashes."""
from pathlib import Path
import argparse, hashlib, json, zipfile
root=Path(__file__).resolve().parents[1]
ext=root/'windows/QuickBuy-Extension'
p=argparse.ArgumentParser();p.add_argument('--verify',action='store_true');args=p.parse_args()
manifest=ext/'BUILD_MANIFEST.json'
data=json.loads(manifest.read_text(encoding='utf-8'))
files={x.relative_to(ext).as_posix():hashlib.sha256(x.read_bytes()).hexdigest() for x in sorted(ext.rglob('*')) if x.is_file() and x!=manifest}
if args.verify:
    if data['files']!=files:raise SystemExit('FAIL stale build hashes')
    print('PASS current checkout build hashes');raise SystemExit(0)
data['files']=files
manifest.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
out=root/'runtime-results';out.mkdir(exist_ok=True)
zip_path=out/'QuickBuy-1.0-Windows.zip'
with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
    for x in sorted((root/'windows').rglob('*')):
        if x.is_file():z.write(x,'QuickBuy-1.0-Windows/'+x.relative_to(root/'windows').as_posix())
(out/'QuickBuy-1.0-SHA256SUMS.txt').write_text(hashlib.sha256(zip_path.read_bytes()).hexdigest()+'  '+zip_path.name+'\n')
print(zip_path)
