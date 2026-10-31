import numpy as np, onnxruntime as ort, soundfile as sf, subprocess, sys, time
def load(path):
    raw = subprocess.run(['ffmpeg','-v','quiet','-i',path,'-f','f32le','-ac','2','-ar','44100','-'],capture_output=True).stdout
    return np.frombuffer(raw,dtype=np.float32).reshape(-1,2).T.copy()
class MDX:
    def __init__(s, path, n_fft, dim_f, dim_t=256, hop=1024, threads=4):
        o=ort.SessionOptions(); o.intra_op_num_threads=threads
        s.sess=ort.InferenceSession(path,o,providers=['CPUExecutionProvider'])
        s.n_fft,s.dim_f,s.dim_t,s.hop=n_fft,dim_f,dim_t,hop
        s.chunk=hop*(dim_t-1); s.trim=n_fft//2; s.gen=s.chunk-2*s.trim
        s.win=(0.5-0.5*np.cos(2*np.pi*np.arange(n_fft)/n_fft)).astype(np.float32)
    def stft(s,x):  # x [2, chunk] -> [1,4,dim_f,dim_t]
        p=s.n_fft//2; xp=np.pad(x,((0,0),(p,p)),mode='reflect')
        idx=np.arange(s.dim_t)[:,None]*s.hop+np.arange(s.n_fft)[None]
        fr=xp[:,idx]*s.win  # [2,T,n_fft]
        X=np.fft.rfft(fr,axis=-1)[:,:,:s.dim_f]  # [2,T,F]
        out=np.stack([X[0].real,X[0].imag,X[1].real,X[1].imag]).transpose(0,2,1)
        return out[None].astype(np.float32)
    def istft(s,spec):
        nb=s.n_fft//2+1; sp=spec[0].transpose(0,2,1)  # [4,T,F]
        X=np.zeros((2,s.dim_t,nb),np.complex64)
        X[0,:,:s.dim_f]=sp[0]+1j*sp[1]; X[1,:,:s.dim_f]=sp[2]+1j*sp[3]
        fr=np.fft.irfft(X,n=s.n_fft,axis=-1)*s.win
        L=s.n_fft+s.hop*(s.dim_t-1); y=np.zeros((2,L)); w=np.zeros(L)
        for t in range(s.dim_t):
            y[:,t*s.hop:t*s.hop+s.n_fft]+=fr[:,t]; w[t*s.hop:t*s.hop+s.n_fft]+=s.win**2
        p=s.n_fft//2; y=y[:,p:p+s.chunk]/np.maximum(w[p:p+s.chunk],1e-8)
        return y
    def run(s,mix,denoise=False):
        n=mix.shape[1]; pad=s.gen-n%s.gen
        mp=np.concatenate([np.zeros((2,s.trim)),mix,np.zeros((2,pad)),np.zeros((2,s.trim))],1).astype(np.float32)
        outs=[]
        for i in range(0,n+pad,s.gen):
            spec=s.stft(mp[:,i:i+s.chunk])
            o=s.sess.run(None,{'input':spec})[0]
            if denoise: o=0.5*o-0.5*s.sess.run(None,{'input':-spec})[0]
            outs.append(s.istft(o)[:,s.trim:-s.trim])
        return np.concatenate(outs,1)[:,:n]
if __name__=='__main__':
    m=MDX(sys.argv[1],int(sys.argv[2]),3072)
    print([ (i.name,i.shape) for i in m.sess.get_inputs()])
    mix=load(sys.argv[3]); t=time.time(); v=m.run(mix); print('secs',time.time()-t,'dur',mix.shape[1]/44100)
    inst=mix-v; sf.write(sys.argv[4]+'_vocals.wav',v.T,44100); sf.write(sys.argv[4]+'_inst.wav',inst.T,44100)
    # sanity: energy ratios
    print('rms mix/voc/inst',[float(np.sqrt((a**2).mean())) for a in (mix,v,inst)])
