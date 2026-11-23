from PIL import Image
d=r"C:\Users\air\Documents\deepseek-harness\remote\research\_probe"
for n in ["ui-q1.png","ui-q5.png","ab2-skipoff.png"]:
    im=Image.open(d+"\\"+n).convert("RGB")
    w,h=im.size
    print(n, im.size)
    # 浮层区域：y:200 起（dp），窗口宽约900-1000，中心x=540
    box=(90, 220, 990, 520)
    px=list(im.crop(box).getdata()); t=len(px)
    white=sum(1 for R,G,B in px if R>235 and G>235 and B>235)
    dark =sum(1 for R,G,B in px if R<110 and G<110 and B<110)
    colored=sum(1 for R,G,B in px if max(R,G,B)-min(R,G,B)>40)
    print("  white=%.1f%% dark=%.1f%% colored=%.1f%%"%(white*100/t,dark*100/t,colored*100/t))