"""Compare local high-frequency noise on shared flat patches, not overall image quality.

Apple input is a linear ProPhoto TIFF32f. Candidates are Stage 1 PNG16 working
copies or TIFF32f. The statistic differs from the earlier #17116 measurement;
ratios from the two methods must not be mixed.
"""

import argparse, json
import cv2, numpy as np, tifffile

p=argparse.ArgumentParser()
p.add_argument('--apple',required=True)
p.add_argument('--candidates',nargs='+',required=True)
p.add_argument('--out',help='Optional JSON result path; stdout is always printed')
a=p.parse_args()

def load(path):
    if path.endswith('.tiff'):
        return tifffile.imread(path).astype(np.float32)
    im=cv2.imread(path,cv2.IMREAD_UNCHANGED)
    if im is None or im.dtype != np.uint16 or im.shape[2] != 3:
        raise ValueError(f'Expected RGB16 PNG: {path}')
    return 2.0*np.power(im[:,:,::-1].astype(np.float32)/65535,1.8)

def channels(im):
    im=np.maximum(im,1e-5)
    y=0.2880402*im[:,:,0]+0.7118741*im[:,:,1]+0.0000857*im[:,:,2]
    lg=np.log(np.maximum(y,1e-5))
    return np.stack([lg,np.log(im[:,:,0]/im[:,:,1]),np.log(im[:,:,2]/im[:,:,1])],axis=2)

ref=load(a.apple)
h,w=ref.shape[:2]
ch=channels(ref)
# Define sample patches from Apple only, with no clipped or deep-shadow pixels.
y=np.exp(ch[:,:,0]); smooth=cv2.GaussianBlur(y,(0,0),5)
grad=np.hypot(cv2.Sobel(smooth,cv2.CV_32F,1,0,ksize=3),cv2.Sobel(smooth,cv2.CV_32F,0,1,ksize=3))
tile=48; scores=[]
for yy in range(96,h-96-tile,tile):
    for xx in range(96,w-96-tile,tile):
        sy=slice(yy,yy+tile);sx=slice(xx,xx+tile)
        v=y[sy,sx];g=grad[sy,sx]
        med=float(np.median(v))
        if 0.025 <= med <= 0.6 and np.max(v)<0.95:
            scores.append((float(np.median(g))/max(med,0.025), yy,xx))
scores.sort()
selected=[(yy,xx) for _,yy,xx in scores[:min(150,max(15,len(scores)//4))]]
if len(selected)<10: raise ValueError('insufficient flat patches')

def noise(im):
    c=channels(im)
    result=[]
    # Local high pass is evaluated per shared Apple-selected patch so geometry
    # shifts elsewhere do not contaminate edge pixels.
    for k in range(3):
        vals=[]
        for yy,xx in selected:
            patch=c[yy:yy+tile,xx:xx+tile,k]
            hi=patch-cv2.GaussianBlur(patch,(0,0),2)
            hi=hi[6:-6,6:-6]
            vals.append(1.4826*np.median(np.abs(hi-np.median(hi))))
        result.append(float(np.median(vals)))
    return result
r=noise(ref)
results=[]
for path in a.candidates:
    c=load(path)
    if c.shape!=ref.shape: raise ValueError(f'size mismatch {path}')
    n=noise(c)
    results.append({'path':path,'luma':n[0], 'chroma_rg':n[1], 'chroma_bg':n[2],
                    'luma_ratio':n[0]/r[0],'chroma_ratio':np.hypot(n[1],n[2])/np.hypot(r[1],r[2])})
report=json.dumps({'schema':'niho-quality-probe.flat-noise/1','apple':a.apple,'patches':len(selected),'selection':'lowest 25% relative gradient, middle luminance, 48px patches, max150','apple_noise':r,'candidates':results},indent=2)
if a.out:
    from pathlib import Path
    Path(a.out).write_text(report+'\n',encoding='utf-8')
print(report)
