"""Make a private sRGB JPEG for viewing linear ProPhoto TIFF32f / Stage 1 PNG16.

Both Apple and NIHO inputs receive the same matrix and transfer function.
No display tone curve is applied, so this is for relative comparison only.
"""

import argparse, os
import cv2, numpy as np, tifffile
p=argparse.ArgumentParser()
p.add_argument('input');p.add_argument('output');p.add_argument('--size',type=int,default=1500);p.add_argument('--ev',type=float,default=0)
a=p.parse_args()
if a.input.endswith('.tiff'):
 im=tifffile.imread(a.input).astype(np.float32)
else:
 b=cv2.imread(a.input,cv2.IMREAD_UNCHANGED)
 if b is None or b.dtype!=np.uint16: raise ValueError('expected PNG16')
 im=2*(b[:,:,::-1].astype(np.float32)/65535)**1.8
# D50 linear ProPhoto -> D65 linear sRGB, same matrix as colorcheck/color.py.
pp=np.array([[.7976749,.1351917,.0313534],[.2880402,.7118741,.0000857],[0,0,.8252100]],np.float32)
srgb=np.array([[.4360747,.3850649,.1430804],[.2225045,.7168786,.0606169],[.0139322,.0971045,.7141733]],np.float32)
m=np.linalg.solve(srgb,pp).astype(np.float32)
im=cv2.resize(im,(round(im.shape[1]*a.size/max(im.shape[:2])),round(im.shape[0]*a.size/max(im.shape[:2]))),interpolation=cv2.INTER_AREA)
x=np.clip((im@ m.T)*2**a.ev,0,1)
x=np.where(x<=.0031308,12.92*x,1.055*np.power(x,1/2.4)-.055)
os.makedirs(os.path.dirname(os.path.abspath(a.output)),exist_ok=True)
cv2.imwrite(a.output,cv2.cvtColor(np.uint8(np.clip(np.rint(x*255),0,255)),cv2.COLOR_RGB2BGR),[cv2.IMWRITE_JPEG_QUALITY,92])
