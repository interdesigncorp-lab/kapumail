// electron-builder afterPack: a Windows-os Iratkapu.exe ikonjának cseréje a plüssfigurára.
// Azért kell, mert macOS-ről építve nincs rcedit (signAndEditExecutable: false), így az exe az Electron alapikonjával maradna.
// A resedit tiszta JavaScript, wine nélkül fut.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');
const PELibrary = require('pe-library');

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const exePath = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  const icoPath = await ctx.packager.getIconPath(); // az assets/icon.png-ből készített .ico
  if (!icoPath) throw new Error('Nincs ikon a Windows-buildhez');
  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error('Az exe-ben nincs ikoncsoport');
  for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map(i => i.data));
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • Windows-ikon beírva  exe=' + path.basename(exePath) + ' csoportok=' + groups.length);
};
