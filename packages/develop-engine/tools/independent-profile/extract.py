#!/usr/bin/env python3
"""Owned-source extraction; no manufacturer matrix, DCP or rawtoaces data is loaded.

Private raw/JPEG paths and metadata are retained only in a temporary directory
on the caller-provided scratch volume, then deleted. No real-user data is allowed.
The output contains only anonymous source SHA and averaged RGB measurement pairs.
"""
from pathlib import Path
import subprocess, json, hashlib, zlib, struct, os
import numpy as np
from PIL import Image,ImageOps
import argparse, tempfile, io
parser=argparse.ArgumentParser(description="Extract owned RAW/camera JPEG block means. Supply ordered five training and two validation originals; freeze the split before fitting.")
parser.add_argument('--decoder',type=Path,required=True)
parser.add_argument('--scratch-root',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('raws',type=Path,nargs=7)
args=parser.parse_args()
if args.output.resolve() in {p.resolve() for p in args.raws} or any(args.output.exists() and args.output.samefile(p) for p in args.raws):
 raise SystemExit('Output must not alias an original.')
binary=args.decoder
raws=args.raws
if len({hashlib.sha256(p.read_bytes()).hexdigest() for p in raws}) != 7:
 raise SystemExit('Seven distinct owned source photos are required.')
private_work=tempfile.TemporaryDirectory(prefix='niho-profile-extract-',dir=args.scratch_root)
scratch=Path(private_work.name)
validation=set(raws[-2:]); scenes=[]
def png16(path):
 b=path.read_bytes();i=8;parts=[]
 while i<len(b):
  n=int.from_bytes(b[i:i+4],'big');typ=b[i+4:i+8]
  if typ==b'IHDR':w,h,depth,color=struct.unpack('>IIBB',b[i+8:i+18]);assert depth==16 and color==2
  if typ==b'IDAT':parts.append(b[i+8:i+8+n])
  i+=n+12
 raw=zlib.decompress(b''.join(parts));stride=w*6;out=np.zeros((h,stride),dtype=np.uint8)
 for y in range(h):
  f=raw[y*(stride+1)];row=bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
  for x in range(stride):
   a=row[x-6] if x>=6 else 0;b=int(out[y-1,x]) if y else 0;c=int(out[y-1,x-6]) if y and x>=6 else 0
   if f==1:v=a
   elif f==2:v=b
   elif f==3:v=(a+b)//2
   elif f==4:
    q=a+b-c;ds=[abs(q-a),abs(q-b),abs(q-c)];v=[a,b,c][ds.index(min(ds))]
   else:v=0
   row[x]=(row[x]+v)&255
  out[y]=np.frombuffer(row,dtype=np.uint8)
 return (out.tobytes(),w,h)
for i,p in enumerate(raws):
 ident=f'scene-{i+1:02}';d=scratch/ident;d.mkdir(exist_ok=True)
 rawbytes=p.read_bytes();jpeg=subprocess.check_output(['exiftool','-b','-JpgFromRaw',str(p)]);(d/'reference.jpg').write_bytes(jpeg)
 r=subprocess.run([str(binary),'dump-camera','--raw',str(p),'--out',str(d/'camera.png'),'--long-edge','256'],capture_output=True)
 if r.returncode:raise RuntimeError('camera decode failed')
 data,w,h=png16(d/'camera.png');camera=(np.frombuffer(data,dtype='>u2').reshape(h,w,3).astype(float)/65535)**1.8*2
 ref=ImageOps.exif_transpose(Image.open(d/'reference.jpg'))
 if (w<h)!=(ref.width<ref.height):ref=ref.transpose(Image.Transpose.ROTATE_270)
 ref=ref.resize((w,h),Image.Resampling.LANCZOS).convert('RGB');ref.save(d/'reference-small.png')
 encoded=np.asarray(ref,dtype=float)/255;linear=np.where(encoded<=.04045,encoded/12.92,((encoded+.055)/1.055)**2.4)
 # Block means suppress JPEG noise and subpixel lens geometry; no per-image fitted color correction.
 pairs=[]
 for yy in range(4,h-5,8):
  for xx in range(4,w-5,8):
   c=camera[yy-2:yy+3,xx-2:xx+3].mean((0,1));r=linear[yy-2:yy+3,xx-2:xx+3].mean((0,1))
   if min(c)<.003 or max(c)>.8 or min(r)<.003 or max(r)>.8:continue
   pairs.append([[round(float(x),7) for x in c],[round(float(x),7) for x in r]])
 scenes.append({'id':ident,'split':'validation' if p in validation else 'train','rawSha256':hashlib.sha256(rawbytes).hexdigest(),'cameraJpegSha256':hashlib.sha256(jpeg).hexdigest(),'cameraPngSha256':hashlib.sha256((d/'camera.png').read_bytes()).hexdigest(),'pairs':pairs})
 print(ident,scenes[-1]['split'],'pairs',len(pairs))
payload={'schema':'niho.independent-camera-measurements/1','camera':'Panasonic DC-S5','ownership':'2026-10-20 owner confirms these originals and camera JPEG outputs are owner-created; no real-user photos.','input':'white-balanced camera RGB from RAW sensor samples; reference is embedded owner camera JPEG decoded to linear sRGB.','split':'First five complete source photos train; final two complete photos held out before fitting. No LibRaw/rawtoaces/profile matrix is used.','metric':'Color-only CIE76 after matching per-pixel XYZ Y. Tone/exposure and colorimetric chart accuracy are not asserted.','gate':{'validationMeanDeltaE76':8.0,'validationP95DeltaE76':18.0,'minimumPairsPerScene':100},'scenes':scenes}
args.output.write_text(json.dumps(payload,indent=2)+'\n')
private_work.cleanup()
print('measurement extraction completed',len(scenes))
