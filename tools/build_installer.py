"""Build a self-contained setup using Windows' .NET Framework compiler. Does not install."""
from pathlib import Path
import hashlib,json,zipfile,subprocess,sys
root=Path(__file__).resolve().parents[1]
subprocess.run(['node',str(root/'tools/build_extension.mjs')],check=True)
output=root/'outputs';output.mkdir(exist_ok=True)
version=json.loads((root/'manifest.json').read_text())['version']
names=['manifest.json','segretario.js','background.js','lab_catalog.json','paddle_sandbox.html','paddle_sandbox.js','README.txt','VERIFICA_PADDLEOCR_BROWSER.ps1','PaddleOCR_Browser/paddleocr_bridge.mjs']
names += [p.relative_to(root).as_posix() for p in (root/'vendor').rglob('*') if p.is_file()]
assert len(names)==len(set(names))
assert all('..' not in Path(n).parts for n in names)
inventory={'version':version,'files':[{'path':n,'sha256':hashlib.sha256((root/n).read_bytes()).hexdigest()} for n in names]}
update=output/'segretario-mmg-update.zip'
with zipfile.ZipFile(update,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 z.writestr('inventory.json',json.dumps(inventory,indent=2))
 for n in names:z.write(root/n,'extension/'+n)
(root/'work').mkdir(exist_ok=True)
package=root/'work/installer-package.zip'
with zipfile.ZipFile(package,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 with zipfile.ZipFile(update) as u:
  for n in u.namelist():z.writestr('payload/'+n,u.read(n))
 z.write(root/'installer/Setup.ps1','Setup.ps1')
 z.write(root/'installer/Setup.Helpers.ps1','Setup.Helpers.ps1')
 for p in (root/'installer/runtime').glob('*'):z.write(p,'runtime/'+p.name)
csc=Path('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe')
exe=output/f'SegretarioMMG-Setup-{version}.exe'
subprocess.run([str(csc),'/nologo','/target:winexe','/platform:x64',f'/out:{exe}',f'/win32manifest:{root / "installer/launcher.manifest"}',f'/resource:{package},package.zip','/reference:System.IO.Compression.FileSystem.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',str(root/'installer/Launcher.cs')],check=True)
# Independent archive re-read, hash and privacy inventory checks.
with zipfile.ZipFile(update) as z:
 assert set(z.namelist())=={'inventory.json'}|{'extension/'+n for n in names}
 for f in inventory['files']:assert hashlib.sha256(z.read('extension/'+f['path'])).hexdigest()==f['sha256']
 assert not any(n.lower().endswith(('.pdf','.xlsx','.log')) or '/sn' in n for n in z.namelist())
with zipfile.ZipFile(package) as z:
 assert 'Setup.ps1' in z.namelist() and 'Setup.Helpers.ps1' in z.namelist() and 'runtime/Startup.ps1' in z.namelist()
 assert 'runtime/Uninstall.ps1' in z.namelist() and 'runtime/Uninstall.Helpers.ps1' in z.namelist()
for p in [exe,update]:
 (output/(p.name+'.sha256')).write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n')
print(json.dumps({'version':version,'extension_files':len(names),'installer_bytes':exe.stat().st_size,'update_bytes':update.stat().st_size}))
