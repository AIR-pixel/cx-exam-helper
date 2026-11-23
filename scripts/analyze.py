from PIL import Image
import sys

path = sys.argv[1]
im = Image.open(path).convert("RGB")
print("size", im.size)
w, h = im.size
for name, box in [
    ("top", (0, 0, w, int(h * 0.4))),
    ("middle", (0, int(h * 0.4), w, int(h * 0.65))),
    ("ime_area", (0, int(h * 0.65), w, h)),
]:
    crop = im.crop(box)
    colors = crop.getcolors(maxcolors=10000000)
    n = len(colors) if colors else ">10M"
    px = list(crop.getdata())
    avg = sum(sum(p) for p in px) / (len(px) * 3)
    black = sum(1 for p in px if max(p) < 20) / len(px)
    print(name, "distinct=", n, "avg=%.1f" % avg, "black_ratio=%.3f" % black)
