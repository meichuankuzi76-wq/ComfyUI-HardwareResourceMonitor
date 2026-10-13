import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';

const defaults = {interval:1000,gpu:'',hidden:[]};
const key = 'HardwareResourceMonitor.v1';
let settings={...defaults}, last=null, timer, observer;
try {{const saved=JSON.parse(localStorage.getItem(key)||localStorage.getItem('PulseDock.v1')||'{}');settings={interval:saved.interval||1000,gpu:saved.gpu||'',hidden:saved.hidden||[]}}} catch {}
settings.interval=[500,1000,2000].includes(Number(settings.interval))?Number(settings.interval):1000;
if(!Array.isArray(settings.hidden))settings.hidden=[];
settings.hidden=settings.hidden.filter(id=>id!=='model');
const labels={cpu:'CPU',ram:'内存',gpu:'GPU',vram:'显存',temperature:'GPU温度',memory_temperature:'显存温度',power:'GPU功率'};
const colors={cpu:'#22b5ff',ram:'#21e795',gpu:'#12cbe5',vram:'#12cbe5',temperature:'#ffc34d',memory_temperature:'#ff9254',power:'#b576ff'};
const paths={cpu:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',ram:'<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4m4-4v4m4-4v4m4-4v4"/>',gpu:'<rect x="2" y="6" width="19" height="12" rx="2"/><circle cx="9" cy="12" r="3"/><path d="M15 10h3m-3 4h3"/>',vram:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 14h10m-10 3h6"/>',temperature:'<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"/><path d="M12 8v10"/>',power:'<path d="m14 2-9 12h7l-2 8 9-12h-7Z"/>'};
const svg=id=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+paths[id==='memory_temperature'?'temperature':id]+'</svg>';
const root=document.createElement('div');root.id='hardware-resource-monitor';root.title='硬件资源监控 · 滚轮横向查看';
root.innerHTML='<button class="hrm-nav" data-left aria-label="向左查看">‹</button><div class="hrm-scroll" tabindex="0" aria-label="资源监控，左右滑动查看"></div><button class="hrm-nav" data-right aria-label="向右查看">›</button><button class="hrm-tools" aria-label="打开监控设置">⚙<span>设置</span></button>';
const scroll=root.querySelector('.hrm-scroll');
const cards={};
for(const [id,label] of Object.entries(labels)){
 const card=document.createElement('div');card.className='hrm-card'+(['ram','vram','gpu'].includes(id)?' hrm-wide':'');card.dataset.metric=id;card.style.setProperty('--accent',colors[id]);
 card.innerHTML='<div class="hrm-label">'+svg(id)+'<span>'+label+'</span></div><strong>--</strong><small></small><div class="hrm-track"><i></i></div>';
 cards[id]=card;scroll.append(card);
}
const panel=document.createElement('div');panel.id='hardware-resource-monitor-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','监控设置');
panel.innerHTML='<div class="hrm-heading"><div><b>监控设置</b><small>ComfyUI-HardwareResourceMonitor · v1.0</small></div><button data-close aria-label="关闭监控设置">×</button></div><p class="hrm-section">监控总览</p><div class="hrm-preview" aria-label="全部监控读数"></div><div class="hrm-fields"><label>刷新间隔<select data-interval><option value="500">0.5 秒</option><option value="1000">1 秒</option><option value="2000">2 秒</option></select></label><label>选择显卡<select data-gpu></select></label></div><p class="hrm-section">显示项目</p><div class="hrm-checks"></div><div class="hrm-diagnostic">正在连接采集服务…</div><p class="hrm-help">“未支持”表示驱动或硬件未提供读数。部分传感器需要以管理员权限启动 ComfyUI。</p><div class="hrm-footer"><button data-copy>复制诊断信息</button><button data-reset>恢复默认</button></div>';
for(const [id,label] of Object.entries(labels)){
 const wrap=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.dataset.metric=id;wrap.append(input,document.createTextNode(label));panel.querySelector('.hrm-checks').append(wrap);
}
function save(){try{localStorage.setItem(key,JSON.stringify(settings))}catch{} apply();if(last)render(last)}
function apply(){panel.querySelector('[data-interval]').value=settings.interval;for(const input of panel.querySelectorAll('[data-metric]'))input.checked=!settings.hidden.includes(input.dataset.metric);for(const [id,card]of Object.entries(cards))card.hidden=settings.hidden.includes(id)}
function position(){const box=root.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,box.right-panel.offsetWidth))+'px';panel.style.top=Math.max(8,Math.min(innerHeight-panel.offsetHeight-8,box.bottom+8))+'px'}
function close(){panel.hidden=true;root.querySelector('.hrm-tools').setAttribute('aria-expanded','false')}
root.querySelector('.hrm-tools').onclick=()=>{panel.hidden=!panel.hidden;root.querySelector('.hrm-tools').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)position()};panel.querySelector('[data-close]').onclick=close;
root.querySelector('[data-left]').onclick=()=>scroll.scrollBy({left:-180,behavior:'smooth'});root.querySelector('[data-right]').onclick=()=>scroll.scrollBy({left:180,behavior:'smooth'});
scroll.addEventListener('wheel',e=>{if(e.ctrlKey||scroll.scrollWidth<=scroll.clientWidth)return;e.preventDefault();scroll.scrollLeft+=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY},{passive:false});
scroll.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();scroll.scrollBy({left:e.key==='ArrowRight'?150:-150,behavior:'smooth'})}});
document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!root.contains(e.target))close()});window.addEventListener('resize',()=>{if(!panel.hidden)position()});
for(const field of ['interval','gpu'])panel.querySelector('[data-'+field+']').onchange=e=>{settings[field]=field==='interval'?Number(e.target.value):e.target.value;save()};
for(const input of panel.querySelectorAll('[data-metric]'))input.onchange=()=>{settings.hidden=[...panel.querySelectorAll('[data-metric]')].filter(x=>!x.checked).map(x=>x.dataset.metric);save()};
panel.querySelector('[data-reset]').onclick=()=>{settings={...defaults,hidden:[]};save()};panel.querySelector('[data-copy]').onclick=async e=>{try{await navigator.clipboard.writeText(JSON.stringify(last,null,2));e.target.textContent='已复制'}catch{e.target.textContent='复制失败'}};
function capacity(used,total){const divisor=1024**3;return used!=null&&total>0?(used/divisor).toFixed(1)+' / '+(total/divisor).toFixed(1)+' GB':'未支持'}
function metric(id,value,suffix,sub='',percent=value){const card=cards[id];card.querySelector('strong').textContent=Number.isFinite(value)?(suffix===' W'?value.toFixed(1):Math.round(value))+suffix:'未支持';card.querySelector('small').textContent=sub;card.querySelector('i').style.height=(Number.isFinite(percent)?Math.max(0,Math.min(100,percent)):0)+'%';card.title=labels[id]+'：'+card.querySelector('strong').textContent+(sub?' · '+sub:'')}
function render(data){last=data;const select=panel.querySelector('[data-gpu]');const signature=JSON.stringify(data.gpus.map(g=>[g.id,g.name]));if(select.dataset.signature!==signature){select.replaceChildren();for(const g of data.gpus){const option=document.createElement('option');option.value=g.id;option.textContent=g.name.replace(/^NVIDIA\s+(?:GeForce\s+)?/i,'').replace(/^AMD\s+/i,'');option.title=g.name;select.append(option)}select.dataset.signature=signature}
 const gpu=data.gpus.find(g=>g.id===settings.gpu)||data.gpus[0]||{};select.value=gpu.id||'';select.title=gpu.name||'未检测到显卡';
 metric('cpu',data.cpu,'%');metric('ram',data.ram_percent,'%',capacity(data.ram_used,data.ram_total));metric('gpu',gpu.utilization,'%',(gpu.name||'未检测到显卡').replace(/^NVIDIA\s+(?:GeForce\s+)?/i,''));
 const vp=gpu.memory_total>0&&gpu.memory_used!=null?gpu.memory_used/gpu.memory_total*100:null;metric('vram',vp,'%',capacity(gpu.memory_used,gpu.memory_total));metric('temperature',gpu.temperature,'°C');metric('memory_temperature',gpu.memory_temperature,'°C');metric('power',gpu.power,' W','',gpu.power_limit>0&&gpu.power!=null?gpu.power/gpu.power_limit*100:null);
 panel.querySelector('.hrm-preview').replaceChildren(...Object.entries(cards).map(([id,card])=>{const copy=card.cloneNode(true);copy.removeAttribute('data-metric');copy.dataset.preview=id;copy.hidden=false;return copy}));
 panel.querySelector('.hrm-diagnostic').textContent='采集来源：'+(gpu.source||'未检测到')+' · '+(data.platform||'')+(data.sensor_error?' · 传感器提示：'+data.sensor_error:'');
}
async function poll(){if(!document.hidden){try{const response=await api.fetchApi('/hardware-resource-monitor/stats',{signal:AbortSignal.timeout(10000),cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);render(await response.json());root.classList.remove('hrm-offline')}catch(e){root.classList.add('hrm-offline');panel.querySelector('.hrm-diagnostic').textContent='采集连接失败：'+e.message;for(const card of Object.values(cards)){card.querySelector('strong').textContent='离线';card.querySelector('small').textContent='';card.querySelector('i').style.height='0%'}}}timer=setTimeout(poll,settings.interval)}
function mount(){
 const manager=document.querySelector('button[aria-label="ComfyUI Manager"],button[title="ComfyUI Manager"]');
 const group=manager?.closest('.comfyui-button-group');
 const legacy=app.menu?.settingsGroup?.element;
 const anchor=group?.isConnected?group:(legacy?.isConnected?legacy:null);
 if(anchor){if(root.parentElement!==anchor.parentElement||root.nextElementSibling!==anchor)anchor.before(root);root.classList.remove('hrm-waiting');return}
 const toolbar=document.querySelector('.actionbar-container');
 if(toolbar){if(root.parentElement!==toolbar)toolbar.prepend(root);root.classList.remove('hrm-waiting');return}
 root.classList.add('hrm-waiting');
}
app.registerExtension({name:'HardwareResourceMonitor.Resources',setup(){if(document.getElementById('hardware-resource-monitor'))return;const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./hardware-resource-monitor.css',import.meta.url).href;document.head.append(style);document.body.append(panel);apply();mount();observer=new MutationObserver(()=>{mount()});observer.observe(document.body,{childList:true,subtree:true});poll()}});
