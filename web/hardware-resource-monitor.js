import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';

const VERSION='v1.1';
const KEY='HardwareResourceMonitor.v2';
const definitions={
 cpu:['CPU','#49b7ff'],cpu_power:['CPU功耗','#ab8dff'],
 ram:['内存','#36d7a1'],virtual:['虚拟内存','#86b7fb'],gpu:['GPU 核心','#35cddb'],vram:['显存','#35cddb'],
 temperature:['GPU温度','#ffc15c'],hotspot:['GPU热点温度','#ff975d'],memory_temperature:['显存温度','#ff975d'],
 power:['GPU功耗','#ba8cff'],fan:['GPU风扇','#49b7ff'],pcie:['PCIe速度','#36d7a1'],
 disk_temperature:['硬盘温度','#ffc15c'],disk_read:['读取速度','#36d7a1'],disk_write:['写入速度','#49b7ff']
};
const presets={common:['cpu','ram','virtual','gpu','vram'],cpu:['cpu','cpu_power','ram','virtual'],
 gpu:['gpu','vram','temperature','hotspot','memory_temperature','power','fan','pcie'],disk:['disk_temperature','disk_read','disk_write'],
 power:['cpu_power','power'],all:Object.keys(definitions)};
const presetLabels={common:'常用',cpu:'CPU',gpu:'GPU',disk:'硬盘',power:'电源',all:'全部'};
const appearanceDefaults={opacity:96,background:'#14202b',fontSize:12,topFontSize:12};
let settings={interval:2000,gpu:'',disk:'',preset:'common',hidden:[],...appearanceDefaults};
try{const saved=JSON.parse(localStorage.getItem(KEY)||localStorage.getItem('HardwareResourceMonitor.v1')||'{}');settings={...settings,...saved};}catch{}
settings.interval=[500,1000,2000,3000].includes(Number(settings.interval))?Number(settings.interval):2000;
settings.preset=presets[settings.preset]?settings.preset:'common';
settings.hidden=Array.isArray(settings.hidden)?settings.hidden.filter(k=>k in definitions):[];
let root,panel,scroll,observer,timer,controller,inFlight=false,last=null,panelPosition=null;
const topCards={},overviewCards={};
const extras={gpu_cuda:['CUDA核心数','#35cddb'],cpu_frequency:['CPU频率','#49b7ff'],ram_frequency:['内存当前频率','#36d7a1'],gpu_frequency:['GPU频率','#35cddb'],vram_frequency:['显存频率','#35cddb']};
const labelFor=id=>(definitions[id]||extras[id])[0];
settings.opacity=Number.isFinite(+settings.opacity)?Math.max(0,Math.min(100,+settings.opacity)):96;
settings.fontSize=Number.isFinite(+settings.fontSize)?Math.max(6,Math.min(20,+settings.fontSize)):12;
settings.topFontSize=Number.isFinite(+settings.topFontSize)?Math.max(6,Math.min(20,+settings.topFontSize)):12;
settings.background=/^#[0-9a-f]{6}$/i.test(settings.background)?settings.background:'#14202b';
let selectedHardware=null,selectedMetric=null;
let chartGeometry=null,chartPointer=null,hoverFrame=null;
const hoverTime=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const histories=new Map();
const groupMetrics={cpu:['cpu','cpu_power','cpu_frequency'],ram:['ram','virtual'],gpu:['gpu','vram','temperature','hotspot','memory_temperature','power','fan','pcie','gpu_frequency','vram_frequency'],disk:['disk_temperature','disk_read','disk_write']};
const text=(element,value)=>{value=String(value);if(element.textContent!==value)element.textContent=value;};
const shortGpu=name=>(name||'未检测到显卡').replace(/^NVIDIA\s+(?:GeForce\s+)?/i,'').replace(/^AMD\s+/i,'');
function card(id){
 const node=document.createElement('div');node.className='hrm-card';node.dataset.id=id;node.style.setProperty('--accent',(definitions[id]||extras[id])[1]);
 node.innerHTML='<span class="hrm-label"></span><strong>--</strong><small></small><div class="hrm-track"><i></i></div>';
 text(node.querySelector('span'),labelFor(id));
 return{node,value:node.querySelector('strong'),sub:node.querySelector('small'),track:node.querySelector('.hrm-track'),fill:node.querySelector('i')};
}
function save(){try{localStorage.setItem(KEY,JSON.stringify(settings));}catch{}apply();if(last)render(last);}
function apply(){
 settings.preset=Object.keys(presets).find(name=>Object.keys(definitions).every(id=>presets[name].includes(id)===!settings.hidden.includes(id)))||'custom';
 applyAppearance();
 panel.querySelector('[data-interval]').value=settings.interval;
 for(const input of panel.querySelectorAll('[data-toggle]'))input.checked=!settings.hidden.includes(input.dataset.toggle);
 for(const button of panel.querySelectorAll('[data-preset]'))button.classList.toggle('active',button.dataset.preset===settings.preset);
 for(const [id,c]of Object.entries(topCards))c.node.hidden=settings.hidden.includes(id);
}
function position(){const r=root.getBoundingClientRect(),below=innerHeight-r.bottom-16;panel.style.maxHeight=Math.max(160,panelPosition?innerHeight-16:below>=200?below:innerHeight-16)+'px';const left=panelPosition?.left??r.right-panel.offsetWidth,top=panelPosition?.top??(below>=200?r.bottom+8:8);panel.style.left=Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,left))+'px';panel.style.top=Math.max(8,Math.min(innerHeight-panel.offsetHeight-8,top))+'px';}
function close(){clearChartHover();panel.hidden=true;root.querySelector('.hrm-settings').setAttribute('aria-expanded','false');}
function makePanel(){
 panel=document.createElement('section');panel.id='hardware-resource-monitor-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','监控设置');
 panel.innerHTML='<header class="hrm-heading"><div><b>监控设置</b><small>ComfyUI-HardwareResourceMonitor · '+VERSION+'</small></div><button data-close aria-label="关闭监控设置">×</button></header><div class="hrm-group"><div class="hrm-section">CPU</div><div class="hrm-cpu-info"></div><div class="hrm-grid" data-group="cpu"></div></div><div class="hrm-group"><div class="hrm-section">内存</div><div class="hrm-grid" data-group="ram"></div></div><div class="hrm-group"><div class="hrm-section">GPU</div><div class="hrm-grid" data-group="gpu"></div></div><div class="hrm-group"><div class="hrm-section">硬盘</div><div class="hrm-grid" data-group="disk"></div></div><div class="hrm-fields"><label>刷新间隔<select data-interval><option value="500">0.5 秒</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="3000">3 秒</option></select></label><label>选择显卡<select data-gpu></select></label><label>选择硬盘<select data-disk></select></label></div><div class="hrm-section">顶部显示预设</div><div class="hrm-presets"></div><div class="hrm-section">显示项目</div><div class="hrm-checks"></div><div class="hrm-fields hrm-appearance"><label>背景透明度<input data-opacity type="range" min="0" max="100"><output data-opacity-value></output></label><label>背景颜色<input data-background type="color"></label><label>面板字号<select data-font><option value="6">6 px</option><option value="7">7 px</option><option value="8">8 px</option><option value="9">9 px</option><option value="10">10 px</option><option value="11">11 px</option><option value="12">12 px</option><option value="13">13 px</option><option value="14">14 px</option><option value="15">15 px</option><option value="16">16 px</option><option value="17">17 px</option><option value="18">18 px</option><option value="19">19 px</option><option value="20">20 px</option></select></label></div><div class="hrm-fields"><label>顶部字号<select data-top-font><option value="6">6 px</option><option value="7">7 px</option><option value="8">8 px</option><option value="9">9 px</option><option value="10">10 px</option><option value="11">11 px</option><option value="12">12 px</option><option value="13">13 px</option><option value="14">14 px</option><option value="15">15 px</option><option value="16">16 px</option><option value="17">17 px</option><option value="18">18 px</option><option value="19">19 px</option><option value="20">20 px</option></select></label></div><footer class="hrm-footer"><button data-copy>复制诊断信息</button><button data-reset>恢复默认</button></footer>';
 const groups={...groupMetrics,ram:[...groupMetrics.ram,'ram_frequency'],gpu:[...groupMetrics.gpu,'gpu_cuda']};
 for(const [group,ids]of Object.entries(groups))for(const id of ids){const c=card(id);overviewCards[id]=c;panel.querySelector('[data-group="'+group+'"]').append(c.node);}
 for(const [id,label]of Object.entries(presetLabels)){const b=document.createElement('button');b.dataset.preset=id;b.textContent=label;b.onclick=()=>{settings.preset=id;settings.hidden=Object.keys(definitions).filter(key=>!presets[id].includes(key));scroll.scrollLeft=0;save();};panel.querySelector('.hrm-presets').append(b);}
 for(const [id,[label]]of Object.entries(definitions)){const wrap=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.dataset.toggle=id;input.onchange=()=>{settings.preset='custom';settings.hidden=[...panel.querySelectorAll('[data-toggle]')].filter(e=>!e.checked).map(e=>e.dataset.toggle);save();};wrap.append(input,document.createTextNode(label));panel.querySelector('.hrm-checks').append(wrap);}
 for(const [key,ids] of Object.entries(groupMetrics)){
  const group=panel.querySelector('[data-group="'+key+'"]').closest('.hrm-group');group.dataset.hardware=key;group.tabIndex=0;group.setAttribute('role','button');group.setAttribute('aria-label',({cpu:'CPU',ram:'内存',gpu:'GPU',disk:'硬盘'})[key]+'历史曲线');
  const choose=()=>selectHardware(key);group.onclick=choose;group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};
 }
 const appearanceControls={opacity:'[data-opacity]',background:'[data-background]',fontSize:'[data-font]',topFontSize:'[data-top-font]'};
 for(const [key,selector]of Object.entries(appearanceControls))panel.querySelector(selector).oninput=e=>{settings[key]=key==='background'?e.target.value:key==='opacity'?100-Number(e.target.value):Number(e.target.value);save();};
 panel.querySelector('[data-close]').onclick=close;
 panel.querySelector('[data-interval]').onchange=e=>{settings.interval=Number(e.target.value);save();schedule(0);};
 for(const name of ['gpu','disk'])panel.querySelector('[data-'+name+']').onchange=e=>{settings[name]=e.target.value;save();schedule(0);};
 panel.querySelector('[data-copy]').onclick=async e=>{try{await navigator.clipboard.writeText(JSON.stringify(last,null,2));text(e.target,'已复制');}catch{text(e.target,'复制失败');}};
 panel.querySelector('[data-reset]').onclick=()=>{settings={interval:2000,gpu:'',disk:'',preset:'common',hidden:[],...appearanceDefaults};save();};
 let drag=null,holdTimer=null,suppressClickUntil=0;
 const endDrag=()=>{clearTimeout(holdTimer);holdTimer=null;if(drag?.active)suppressClickUntil=Date.now()+400;drag=null;panel.classList.remove('hrm-dragging');};
 panel.addEventListener('pointerdown',e=>{
  if(e.button!==0||e.target.closest('input,select,textarea,option'))return;
  const r=panel.getBoundingClientRect();if(e.clientX>r.right-18&&(e.clientY>r.bottom-18||e.target===panel))return;
  drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top,id:e.pointerId,active:false};
  const begin=()=>{if(!drag)return;drag.active=true;panel.classList.add('hrm-dragging');window.getSelection()?.removeAllRanges();panel.setPointerCapture(drag.id);};
  if(e.target.closest('.hrm-heading')&&!e.target.closest('button')){begin();e.preventDefault();}else holdTimer=setTimeout(begin,450);
 });
 panel.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  if(!drag.active){if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>8)endDrag();return;}
  e.preventDefault();const left=Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,drag.left+e.clientX-drag.x)),top=Math.max(8,Math.min(innerHeight-panel.offsetHeight-8,drag.top+e.clientY-drag.y));panel.style.left=left+'px';panel.style.top=top+'px';panelPosition={left,top};
 });
 for(const name of ['pointerup','pointercancel','lostpointercapture'])panel.addEventListener(name,endDrag);
 window.addEventListener('pointerup',endDrag);window.addEventListener('blur',endDrag);
 panel.addEventListener('click',e=>{if(Date.now()<suppressClickUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
 panel.addEventListener('contextmenu',e=>{if(drag?.active)e.preventDefault();});
 const chart=document.createElement('section');chart.className='hrm-chart';chart.hidden=true;chart.innerHTML='<div class="hrm-chart-heading"><b data-chart-title></b><select data-chart-metric aria-label="曲线指标"></select><button data-chart-close>关闭曲线</button></div><div class="hrm-chart-caption"></div><canvas aria-label="硬件最近5分钟曲线" role="img"></canvas><div class="hrm-chart-tooltip" role="tooltip" hidden></div><div class="hrm-chart-hover-line" hidden></div><div class="hrm-chart-hover-dot" hidden></div>';
 panel.append(chart);chart.querySelector('canvas').addEventListener('pointermove',e=>{chartPointer={x:e.clientX,y:e.clientY};if(hoverFrame==null)hoverFrame=requestAnimationFrame(()=>{hoverFrame=null;showChartHover();});});chart.querySelector('canvas').addEventListener('pointerleave',clearChartHover);chart.querySelector('[data-chart-metric]').onchange=e=>{clearChartHover();selectedMetric=e.target.value;drawChart();};chart.querySelector('[data-chart-close]').onclick=()=>{clearChartHover();selectedHardware=null;chart.hidden=true;panel.querySelectorAll('[data-hardware]').forEach(e=>e.setAttribute('aria-pressed','false'));};
 new ResizeObserver(()=>{if(!panel.hidden&&selectedHardware)drawChart();}).observe(chart.querySelector('canvas'));
 document.body.append(panel);
}
function options(selector,rows,selected,shorten=n=>n){
 const select=panel.querySelector(selector),signature=JSON.stringify(rows.map(r=>[r.id,r.name]));
 if(select.dataset.signature!==signature){select.replaceChildren();for(const row of rows){const option=document.createElement('option');option.value=row.id;option.textContent=shorten(row.name);option.title=row.name;select.append(option);}select.dataset.signature=signature;}
 select.value=selected?.id||'';select.title=selected?.name||'未检测到设备';
}
function capacity(used,total){return Number.isFinite(used)&&total>0?(used/1024**3).toFixed(1)+' / '+(total/1024**3).toFixed(1)+' GB':'未支持';}
const speed=value=>Number.isFinite(value)?(value/1e6>=1024?(value/1e6/1024).toFixed(2)+' GB/s':(value/1e6).toFixed(2)+' MB/s'):'未支持';
const number=(value,suffix='',decimals=0)=>Number.isFinite(value)?value.toFixed(decimals)+suffix:'未支持';
function update(id,value,sub='',percent=null){
 for(const c of [topCards[id],overviewCards[id]]){if(!c)continue;text(c.value,value);text(c.sub,sub);c.node.title=labelFor(id)+'：'+value+(sub?' · '+sub:'');c.track.hidden=!Number.isFinite(percent);if(Number.isFinite(percent)){const height=Math.max(0,Math.min(100,percent))+'%';if(c.fill.style.height!==height)c.fill.style.height=height;}}
}
function render(data){
 last=data;
 const gpu=data.gpus.find(g=>g.id===settings.gpu)||data.gpus[0]||{};
 const disk=data.disks.find(d=>d.id===settings.disk)||data.disks[0]||{};
 options('[data-gpu]',data.gpus,gpu,shortGpu);options('[data-disk]',data.disks,disk);
 const info=data.cpu_info||{},s=data.cpu_sensor||{},v=data.virtual_memory||{},cores=(info.cores??'--')+' 核 / '+(info.threads??'--')+' 线程';
 text(panel.querySelector('.hrm-cpu-info'),(info.name||'CPU')+' · '+cores);
 update('cpu',number(data.cpu,'%'),cores,data.cpu);
 update('cpu_power',s.energy?.status==='warming_up'&&s.power==null?'采样中':number(s.power,' W',1),s.power_source?.startsWith('Windows EMI')?'EMI · 封装功耗':'封装功耗');
 update('ram',number(data.ram_percent,'%'),capacity(data.ram_used,data.ram_total),data.ram_percent);
 const virtualLabel=v.kind==='swap'?'交换空间':'虚拟内存';for(const c of [topCards.virtual,overviewCards.virtual])text(c.node.querySelector('.hrm-label'),virtualLabel);
 update('virtual',number(v.percent,'%'),capacity(v.used,v.total)+(v.kind==='commit'?' · 已提交':''),v.percent);
 update('gpu',number(gpu.utilization,'%'),shortGpu(gpu.name),gpu.utilization);
 const vp=gpu.memory_total>0&&gpu.memory_used!=null?gpu.memory_used/gpu.memory_total*100:null;
 update('vram',number(vp,'%'),capacity(gpu.memory_used,gpu.memory_total),vp);
 update('temperature',number(gpu.temperature,'°C'),'',gpu.temperature);
 update('hotspot',number(gpu.hotspot,'°C',1),'',gpu.hotspot);
 update('memory_temperature',number(gpu.memory_temperature,'°C'),'',gpu.memory_temperature);
 update('power',number(gpu.power,' W',1),'上限 '+number(gpu.power_limit,' W'),gpu.power_limit>0&&gpu.power!=null?gpu.power/gpu.power_limit*100:null);
 update('fan',number(gpu.fan_rpm,' RPM'),Number.isFinite(gpu.fan_percent)?gpu.fan_percent+'%':'风扇 1');
 const gt={1:2.5,2:5,3:8,4:16,5:32,6:64}[gpu.pcie_generation];
 update('pcie',speed(gpu.pcie_rx_bps),gpu.pcie_generation&&gpu.pcie_width?gpu.pcie_generation+'.0 ×'+gpu.pcie_width+(gt?' · '+gt+' GT/s':''):'');
 update('disk_temperature',number(disk.temperature,'°C'),disk.name||'未检测到硬盘',disk.temperature);
 update('disk_read',speed(disk.read_bps),disk.name||'');
 update('disk_write',speed(disk.write_bps),disk.name||'');
 update('cpu_frequency',number(s.frequency_mhz,' MHz'),s.frequency_source==='OS reported'?'系统报告频率':'');
 const ramSpeeds=data.memory_info?.configured_speeds_mhz||[];
 update('ram_frequency',ramSpeeds.length?[...new Set(ramSpeeds)].join(' / ')+' MHz':'未支持','');
 update('gpu_cuda',gpu.vendor==='NVIDIA'?number(gpu.cuda_cores):'不适用','');
 update('gpu_frequency',number(gpu.clock_mhz,' MHz'));
 extras.vram_frequency[0]=gpu.memory_clock_basis==='physical'?'显存频率':'显存驱动频率';
 text(overviewCards.vram_frequency.node.querySelector('.hrm-label'),extras.vram_frequency[0]);
 update('vram_frequency',number(gpu.memory_clock_mhz,' MHz',1),gpu.memory_clock_basis==='physical'?(gpu.memory_type||''):'驱动原始读数');
 overviewCards.vram_frequency.node.title+=' · 驱动原始值 '+number(gpu.memory_clock_raw_mhz??gpu.memory_clock_mhz,' MHz',1);
 const memoryOption=panel.querySelector('[data-chart-metric] option[value="vram_frequency"]');if(memoryOption)text(memoryOption,extras.vram_frequency[0]);
 for(const [key,name]of [['gpu',gpu.name],['disk',disk.name]]){const box=panel.querySelector('[data-group="'+key+'"]').closest('.hrm-group');box.title=name||'';}
 root.classList.remove('hrm-offline');
 if(selectedHardware&&!panel.hidden)drawChart();
}

function applyAppearance(){
 const hex=settings.background,alpha=settings.opacity/100;
 panel.style.background='rgba('+parseInt(hex.slice(1,3),16)+','+parseInt(hex.slice(3,5),16)+','+parseInt(hex.slice(5,7),16)+','+alpha+')';
 panel.style.setProperty('--hrm-font',settings.fontSize+'px');
 panel.querySelector('[data-opacity]').value=100-settings.opacity;text(panel.querySelector('[data-opacity-value]'),(100-settings.opacity)+'%');
 panel.querySelector('[data-background]').value=hex;panel.querySelector('[data-font]').value=settings.fontSize;panel.querySelector('[data-top-font]').value=settings.topFontSize;root.style.setProperty('--hrm-top-font',settings.topFontSize+'px');
}
function historyKey(group,data=last){
 if(group==='gpu')return 'gpu:'+(data?.gpus.find(g=>g.id===settings.gpu)||data?.gpus[0])?.id;
 if(group==='disk')return 'disk:'+(data?.disks.find(d=>d.id===settings.disk)||data?.disks[0])?.id;
 return group;
}
function recordHistory(data){
 const now=Date.now(),entries=[['cpu',{cpu:data.cpu,cpu_power:data.cpu_sensor?.power,cpu_frequency:data.cpu_sensor?.frequency_mhz}],['ram',{ram:data.ram_percent,virtual:data.virtual_memory?.percent}]];
 for(const g of data.gpus)entries.push(['gpu:'+g.id,{gpu:g.utilization,vram:g.memory_total>0&&g.memory_used!=null?g.memory_used/g.memory_total*100:null,temperature:g.temperature,hotspot:g.hotspot,memory_temperature:g.memory_temperature,power:g.power,fan:g.fan_rpm,pcie:g.pcie_rx_bps,gpu_frequency:g.clock_mhz,vram_frequency:g.memory_clock_mhz}]);
 for(const d of data.disks)entries.push(['disk:'+d.id,{disk_temperature:d.temperature,disk_read:d.read_bps,disk_write:d.write_bps}]);
 for(const [key,values]of entries){const rows=histories.get(key)||[];const row={time:now,values};if(rows.length&&Math.floor(rows[rows.length-1].time/1000)===Math.floor(now/1000))rows[rows.length-1]=row;else rows.push(row);while(rows.length>1&&(rows[0].time<now-300000||rows.length>305))rows.shift();histories.set(key,rows);}
 for(const key of histories.keys())if(!entries.some(([current])=>current===key))histories.delete(key);
}
function selectHardware(group){
 clearChartHover();
 selectedHardware=group;selectedMetric=groupMetrics[group][0];
 const chart=panel.querySelector('.hrm-chart');chart.hidden=false;
 const select=chart.querySelector('[data-chart-metric]');select.replaceChildren();
 for(const id of groupMetrics[group]){const o=document.createElement('option');o.value=id;o.textContent=labelFor(id);select.append(o);}
 panel.querySelectorAll('[data-hardware]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.hardware===group)));
 drawChart();chart.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function metricText(id,value){
 if(!Number.isFinite(value))return '未支持';
 if(['pcie','disk_read','disk_write'].includes(id))return speed(value);
 if(['cpu','ram','virtual','gpu','vram'].includes(id))return number(value,'%',1);
 if(id.includes('frequency'))return number(value,' MHz',id==='vram_frequency'?1:0);
 if(id==='fan')return number(value,' RPM');
 if(['cpu_power','power'].includes(id))return number(value,' W',1);
 return number(value,'°C',1);
}

function clearChartHover(){
 chartPointer=null;if(hoverFrame!=null){cancelAnimationFrame(hoverFrame);hoverFrame=null;}
 if(panel)for(const e of panel.querySelectorAll('.hrm-chart-tooltip,.hrm-chart-hover-line,.hrm-chart-hover-dot'))e.hidden=true;
}
function showChartHover(){
 const chart=panel.querySelector('.hrm-chart'),tip=chart.querySelector('.hrm-chart-tooltip'),line=chart.querySelector('.hrm-chart-hover-line'),dot=chart.querySelector('.hrm-chart-hover-dot');
 const hide=()=>{tip.hidden=line.hidden=dot.hidden=true;};
 if(!chartPointer||!chartGeometry||chart.hidden||panel.hidden||root.classList.contains('hrm-offline')||panel.classList.contains('hrm-dragging')){hide();return;}
 const canvas=chart.querySelector('canvas'),rect=canvas.getBoundingClientRect(),box=chart.getBoundingClientRect(),x=chartPointer.x-rect.left,y=chartPointer.y-rect.top,g=chartGeometry;
 if(x<g.left||x>g.right||y<g.top||y>g.bottom||!g.points.length){hide();return;}
 let low=0,high=g.points.length;
 while(low<high){const mid=(low+high)>>1;if(g.points[mid].x<x)low=mid+1;else high=mid;}
 const next=g.points[Math.min(low,g.points.length-1)],previous=g.points[Math.max(0,low-1)],point=Math.abs(next.x-x)<Math.abs(previous.x-x)?next:previous;
 if(Math.abs(point.x-x)>Math.max(8,(g.right-g.left)*settings.interval*2.5/300000)){hide();return;}
 text(tip,labelFor(selectedMetric)+' · '+hoverTime.format(new Date(point.time))+'\n'+metricText(selectedMetric,point.value));
 tip.hidden=line.hidden=dot.hidden=false;
 const offsetX=rect.left-box.left+chart.scrollLeft,offsetY=rect.top-box.top+chart.scrollTop;
 tip.style.left=Math.max(4,Math.min(chart.clientWidth-tip.offsetWidth-4,offsetX+point.x+12))+'px';
 tip.style.top=Math.max(4,Math.min(chart.clientHeight-tip.offsetHeight-4,offsetY+point.y-tip.offsetHeight-10))+'px';
 line.style.left=(offsetX+point.x)+'px';line.style.top=(offsetY+g.top)+'px';line.style.height=(g.bottom-g.top)+'px';
 dot.style.left=(offsetX+point.x)+'px';dot.style.top=(offsetY+point.y)+'px';
}

function drawChart(){
 if(!selectedHardware||panel.hidden||document.hidden)return;
 if(root.classList.contains('hrm-offline')){clearChartHover();text(panel.querySelector('.hrm-chart-caption'),'采集连接断开');return;}
 const chart=panel.querySelector('.hrm-chart'),canvas=chart.querySelector('canvas');
 const now=Date.now(),windowMs=300000,rows=(histories.get(historyKey(selectedHardware))||[]).filter(r=>r.time>=now-windowMs),values=rows.map(r=>r.values[selectedMetric]).filter(Number.isFinite);
 const latest=rows.length?rows[rows.length-1].values[selectedMetric]:null;
 text(chart.querySelector('[data-chart-title]'),({cpu:'CPU',ram:'内存',gpu:'GPU',disk:'硬盘'})[selectedHardware]);
 text(chart.querySelector('.hrm-chart-caption'),labelFor(selectedMetric)+' · '+metricText(selectedMetric,latest));
 const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
 const ratio=Math.min(devicePixelRatio||1,2),width=rect.width,height=rect.height;
 if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}
 const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
 const temperature=selectedMetric.includes('temperature')||selectedMetric==='hotspot',percentage=['cpu','ram','virtual','gpu','vram'].includes(selectedMetric);
 let maximum=temperature?120:percentage?100:Math.max(1,...values);
 if(!temperature&&!percentage){const step=10**Math.floor(Math.log10(maximum))/2;maximum=Math.ceil(maximum/step)*step;}
 const points=[];
 const steps=temperature?6:5,font=Math.max(6,settings.fontSize-1);
 ctx.font=font+'px sans-serif';let labelWidth=0;for(let i=0;i<=steps;i++)labelWidth=Math.max(labelWidth,ctx.measureText(metricText(selectedMetric,maximum*i/steps)).width);
 const left=Math.min(width*.42,labelWidth+10),right=width-8,top=10,bottom=height-font*2.5,plotW=right-left,plotH=bottom-top;
 ctx.lineWidth=1;ctx.strokeStyle='rgba(155,190,215,.12)';ctx.beginPath();for(let i=0;i<=steps;i++){let y=bottom-plotH*i/steps;ctx.moveTo(left,y);ctx.lineTo(right,y);}ctx.stroke();
 ctx.strokeStyle='#9cb0c0';ctx.beginPath();ctx.moveTo(left,top);ctx.lineTo(left,bottom);ctx.lineTo(right,bottom);ctx.stroke();
 ctx.fillStyle='#8ca2b4';ctx.textAlign='right';ctx.textBaseline='middle';for(let i=0;i<=steps;i++)ctx.fillText(metricText(selectedMetric,maximum*i/steps),left-7,bottom-plotH*i/steps);
 ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.fillText('5分钟前',left,height-4);ctx.textAlign='center';ctx.fillText('2分30秒前',left+plotW/2,height-4);ctx.textAlign='right';ctx.fillText('当前',right,height-4);
 if(temperature){const y=bottom-90/maximum*plotH;ctx.strokeStyle='#e85b64';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.setLineDash([]);canvas.title='红色虚线为90°C参考线，不是硬件安全温度上限';}else canvas.title='';
 ctx.strokeStyle='#159fff';ctx.lineWidth=1.8;ctx.beginPath();let pen=false,lastTime=0;
 for(const row of rows){const value=row.values[selectedMetric];if(!Number.isFinite(value)){pen=false;continue;}const x=left+Math.max(0,Math.min(1,(row.time-(now-windowMs))/windowMs))*plotW,y=bottom-Math.max(0,Math.min(1,value/maximum))*plotH;points.push({x,y,time:row.time,value});if(!pen||row.time-lastTime>Math.max(settings.interval*2.5,5000))ctx.moveTo(x,y);else ctx.lineTo(x,y);pen=true;lastTime=row.time;}
 ctx.stroke();const latestRow=rows[rows.length-1];if(latestRow&&Number.isFinite(latestRow.values[selectedMetric])){const x=left+Math.max(0,Math.min(1,(latestRow.time-(now-windowMs))/windowMs))*plotW,y=bottom-Math.max(0,Math.min(1,latestRow.values[selectedMetric]/maximum))*plotH;ctx.beginPath();ctx.fillStyle='#159fff';ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();}
 chartGeometry={left,right,top,bottom,points};if(chartPointer)showChartHover();
 if(!values.length){ctx.fillStyle='#94b5cc';ctx.textAlign='center';ctx.fillText('暂无可用读数',left+plotW/2,top+plotH/2);}
}

function schedule(delay=settings.interval){clearTimeout(timer);if(!document.hidden)timer=setTimeout(poll,delay);}
async function poll(){
 if(inFlight||document.hidden)return;
 inFlight=true;controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
 try{
  const gpu=last?.gpus.find(g=>g.id===settings.gpu)||last?.gpus[0];
  const query=new URLSearchParams({disk:settings.disk||last?.disks[0]?.id||'',gpu:gpu?.name||''});
  const response=await api.fetchApi('/hardware-resource-monitor/stats?'+query,{signal:controller.signal,cache:'no-store'});
  if(!response.ok)throw Error('HTTP '+response.status);
  const data=await response.json();if(!document.hidden){recordHistory(data);render(data);}
 }catch(e){if(!document.hidden){root.classList.add('hrm-offline');clearChartHover();for(const id of [...Object.keys(definitions),...Object.keys(extras)])update(id,'离线');if(selectedHardware)text(panel.querySelector('.hrm-chart-caption'),'采集连接断开');}}
 finally{clearTimeout(timeout);inFlight=false;controller=null;schedule();}
}
function mount(){
 const manager=document.querySelector('button[aria-label="ComfyUI Manager"],button[title="ComfyUI Manager"]');
 const anchor=manager?.closest('.comfyui-button-group')||app.menu?.settingsGroup?.element;
 if(anchor?.isConnected){if(root.parentElement!==anchor.parentElement||root.nextElementSibling!==anchor)anchor.before(root);root.classList.remove('hrm-waiting');return;}
 const toolbar=document.querySelector('.actionbar-container');
 if(toolbar){if(root.parentElement!==toolbar)toolbar.prepend(root);root.classList.remove('hrm-waiting');}else root.classList.add('hrm-waiting');
}
app.registerExtension({name:'HardwareResourceMonitor.Resources',setup(){
 if(document.getElementById('hardware-resource-monitor'))return;
 const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./hardware-resource-monitor.css',import.meta.url).href;document.head.append(style);
 root=document.createElement('div');root.id='hardware-resource-monitor';root.innerHTML='<button class="hrm-nav" data-left aria-label="向左查看">‹</button><div class="hrm-scroll" tabindex="0" aria-label="资源监控，左右滑动查看"></div><button class="hrm-nav" data-right aria-label="向右查看">›</button><button class="hrm-settings" aria-expanded="false">设置</button>';
 scroll=root.querySelector('.hrm-scroll');for(const id of Object.keys(definitions)){topCards[id]=card(id);scroll.append(topCards[id].node);}
 makePanel();apply();mount();
 observer=new MutationObserver(()=>{if(!root.isConnected||root.classList.contains('hrm-waiting'))mount();});observer.observe(document.body,{childList:true,subtree:true});
 root.querySelector('.hrm-settings').onclick=()=>{if(!panel.hidden){close();return;}panel.hidden=false;root.querySelector('.hrm-settings').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden){position();if(selectedHardware)drawChart();}};
 for(const [selector,delta]of [['[data-left]',-180],['[data-right]',180]])root.querySelector(selector).onclick=()=>scroll.scrollBy({left:delta,behavior:'smooth'});
 scroll.addEventListener('wheel',e=>{if(e.ctrlKey||scroll.scrollWidth<=scroll.clientWidth)return;e.preventDefault();scroll.scrollLeft+=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;},{passive:false});
 scroll.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();scroll.scrollBy({left:e.key==='ArrowLeft'?-150:150,behavior:'smooth'});}});
 document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!root.contains(e.target)&&!panel.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});window.addEventListener('resize',()=>{if(!panel.hidden)position();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);controller?.abort();}else schedule(0);});
 poll();
}});
