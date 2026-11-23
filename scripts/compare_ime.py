from PIL import Image, ImageChops
import sys

a = Image.open(sys.argv[1]).convert("RGB")  # IME shown
b = Image.open(sys.argv[2]).convert("RGB")  # IME hidden
print("sizes", a.size, b.size)
w, h = a.size

def stats(im, box, label):
    crop = im.crop(box)
    px = list(crop.getdata())
    n = len(px)
    avg = sum(sum(p) for p in px) / (n * 3)
    # 检测"键盘"特征：浅灰按键背景 (~200-240) 或候选栏白底
    light = sum(1 for p in px if min(p) > 150) / n
    black = sum(1 for p in px if max(p) < 25) / n
    print(f"  {label}: avg={avg:.1f} light={light:.3f} black={black:.3f}")

for label, box in [
    ("top 0-40%", (0, 0, w, int(h*0.4))),
    ("mid 40-65%", (0, int(h*0.4), w, int(h*0.65))),
    ("ime 65-85%", (0, int(h*0.65), w, int(h*0.85))),
    ("ime 85-100%", (0, int(h*0.85), w, h)),
]:
    print(label)
    stats(a, box, "IME-SHOWN")
    stats(b, box, "IME-HIDDEN")

diff = ImageChops.difference(a, b)
bbox = diff.getbbox()
print("diff bbox:", bbox)
