# Own re-implementation of the EfficientAT "mn10_as" MobileNetV3 audio tagger (MIT, Florian Schmid)
# so the published weights can be exported to ONNX together with the mel front end.
import torch, torch.nn as nn, torch.nn.functional as F, numpy as np, torchaudio, csv

def mdiv(v, d=8):
    n = max(d, int(v + d / 2) // d * d)
    return n + d if n < 0.9 * v else n

def cna(i, o, k=1, s=1, g=1, act=None):
    L = [nn.Conv2d(i, o, k, s, (k - 1) // 2, groups=g, bias=False), nn.BatchNorm2d(o, eps=0.001)]
    if act: L.append(act())
    return nn.Sequential(*L)

class SE(nn.Module):
    def __init__(s, c):
        super().__init__(); q = mdiv(c // 4); s.fc1 = nn.Linear(c, q); s.fc2 = nn.Linear(q, c)
    def forward(s, x):
        z = x.mean((2, 3)); z = torch.sigmoid(s.fc2(F.relu(s.fc1(z))))
        return x * z[:, :, None, None]
class CSE(nn.Module):
    def __init__(s, c): super().__init__(); s.conc_se_layers = nn.ModuleList([SE(c)])
    def forward(s, x): return s.conc_se_layers[0](x)

class IR(nn.Module):
    def __init__(s, i, k, e, o, se, hs, st):
        super().__init__(); A = nn.Hardswish if hs else nn.ReLU; L = []
        if e != i: L.append(cna(i, e, act=A))
        L.append(cna(e, e, k, st, e, A))
        if se: L.append(CSE(e))
        L.append(cna(e, o)); s.block = nn.Sequential(*L); s.res = st == 1 and i == o
    def forward(s, x):
        y = s.block(x); return y + x if s.res else y

CFG = [(16,3,16,16,0,0,1),(16,3,64,24,0,0,2),(24,3,72,24,0,0,1),(24,5,72,40,1,0,2),(40,5,120,40,1,0,1),(40,5,120,40,1,0,1),
       (40,3,240,80,0,1,2),(80,3,200,80,0,1,1),(80,3,184,80,0,1,1),(80,3,184,80,0,1,1),(80,3,480,112,1,1,1),(112,3,672,112,1,1,1),
       (112,5,672,160,1,1,2),(160,5,960,160,1,1,1),(160,5,960,160,1,1,1)]
class MN(nn.Module):
    def __init__(s):
        super().__init__()
        L = [cna(1, 16, 3, 2, act=nn.Hardswish)] + [IR(*c) for c in CFG] + [cna(160, 960, act=nn.Hardswish)]
        s.features = nn.Sequential(*L)
        s.classifier = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(1), nn.Linear(960, 1280), nn.Hardswish(), nn.Dropout(0.2), nn.Linear(1280, 527))
    def forward(s, x): return s.classifier(s.features(x))

class Tagger(nn.Module):
    """waveform [1, N] at 32 kHz -> sigmoid probabilities [1, 527]"""
    def __init__(s, mn):
        super().__init__(); n_fft, win = 1024, 800
        w = torch.hann_window(win, periodic=False); lp = (n_fft - win) // 2; w = F.pad(w, (lp, n_fft - win - lp))
        k = torch.arange(n_fft // 2 + 1)[:, None].double(); n = torch.arange(n_fft)[None].double(); ang = 2 * np.pi * k * n / n_fft
        s.register_buffer('kre', (torch.cos(ang) * w).float()[:, None, :]); s.register_buffer('kim', (-torch.sin(ang) * w).float()[:, None, :])
        mb, _ = torchaudio.compliance.kaldi.get_mel_banks(128, n_fft, 32000, 0.0, 16000 - 1000, vtln_low=100.0, vtln_high=-500., vtln_warp_factor=1.0)
        s.register_buffer('mb', F.pad(mb, (0, 1))); s.register_buffer('pre', torch.tensor([[[-.97, 1.]]])); s.mn = mn
    def mel(s, x):
        x = F.conv1d(x.unsqueeze(1), s.pre); x = F.pad(x, (512, 512), mode='reflect')
        re = F.conv1d(x, s.kre, stride=320); im = F.conv1d(x, s.kim, stride=320)
        m = torch.matmul(s.mb, re * re + im * im)
        return ((m + 1e-5).log() + 4.5) / 5.
    def forward(s, x): return torch.sigmoid(s.mn(s.mel(x).unsqueeze(1)))

mn = MN(); sd = torch.load('mn10_as.pt', map_location='cpu', weights_only=True)
missing = mn.load_state_dict(sd, strict=True); print('weights loaded', missing)
t = Tagger(mn).eval()
x = torch.randn(1, 320000) * 0.1
# reference mel via torch.stft (as in the original preprocessing) to check the conv1d STFT
with torch.no_grad():
    xx = F.conv1d(x.unsqueeze(1), t.pre).squeeze(1)
    S = torch.stft(xx, 1024, hop_length=320, win_length=800, center=True, window=torch.hann_window(800, periodic=False), return_complex=True)
    ref = ((torch.matmul(t.mb, S.abs() ** 2) + 1e-5).log() + 4.5) / 5.
    print('mel max diff', (ref - t.mel(x)).abs().max().item())
    torch.onnx.export(t, (x,), 'tagger.onnx', input_names=['wave'], output_names=['probs'], opset_version=17, dynamo=False)
print('exported')
