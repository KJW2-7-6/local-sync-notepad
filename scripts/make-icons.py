"""Create the original app icon. Pillow is needed only when regenerating assets."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'assets'
root.mkdir(exist_ok=True)
im = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((14, 14, 498, 498), radius=116, fill='#238a75')
d.rounded_rectangle((144, 94, 368, 412), radius=26, fill='#f4fcf9')
for y, x in [(180, 310), (230, 310), (280, 276)]:
    d.rounded_rectangle((186, y, x, y + 16), radius=8, fill='#238a75')
d.ellipse((307, 316, 437, 446), fill='#b7eedc', outline='#238a75', width=12)
d.line((335, 384, 364, 409, 407, 361), fill='#237e6c', width=14, joint='curve')
im.save(root / 'icon.png')
im.save(root / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
