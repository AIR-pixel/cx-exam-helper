import struct, sys
from PIL import Image

def convert(src, dst):
    data = open(src, "rb").read()
    # screencap -p raw format: 4-byte little-endian length, then RGBA (or BGRA) pixels
    if data[:4] == b'\x89PNG':
        open(dst, "wb").write(data)
        print(src, "already PNG")
        return
    length = struct.unpack('<I', data[:4])[0]
    px = data[4:]
    print(src, "raw length field=", length, "actual=", len(px))
    # Redmi: 1080x2400 RGBA
    for fmt, swap in [("RGBA", False), ("BGRA", True)]:
        try:
            im = Image.frombuffer("RGBA", (1080, 2400), px[:1080*2400*4], "raw", fmt, 0, 1)
            if swap:
                r, g, b, a = im.split()
                im = Image.merge("RGBA", (b, g, r, a))
            im.convert("RGB").save(dst)
            print("  saved as", fmt, "->", dst)
            return
        except Exception as e:
            print("  ", fmt, "fail", e)

convert(sys.argv[1], sys.argv[2])
