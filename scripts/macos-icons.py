"""Generate Finder's standard small/Retina ICNS representations with Apple's tools."""
import pathlib, subprocess, tempfile
root=pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='pocket-icons-') as temporary:
    iconset=pathlib.Path(temporary)/'PocketDrop.iconset';iconset.mkdir()
    for logical in [16,32,128,256,512]:
        for scale in [1,2]:
            size=logical*scale
            name=f'icon_{logical}x{logical}'+('@2x' if scale==2 else '')+'.png'
            subprocess.run(['sips','-z',str(size),str(size),str(root/'assets/icon-source.png'),'--out',str(iconset/name)],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(root/'assets/icon.icns')],check=True)
print('Generated Finder icon using sips and iconutil, standard and Retina 16–1024px.')
