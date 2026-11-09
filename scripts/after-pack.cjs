// Give Finder an explicit, app-specific icon resource instead of reusing the
// generic Electron icon filename that may already be cached by macOS.
const fs = require('node:fs/promises');
const path = require('node:path');
const plist = require('plist');
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const contents = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents');
  await fs.rename(path.join(contents, 'Resources', 'icon.icns'), path.join(contents, 'Resources', 'PocketDrop.icns'));
  const file = path.join(contents, 'Info.plist');
  const info = plist.parse(await fs.readFile(file, 'utf8'));
  info.CFBundleIconFile = 'PocketDrop.icns';
  await fs.writeFile(file, plist.build(info));
};
