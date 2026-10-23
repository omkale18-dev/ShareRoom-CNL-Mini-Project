const $ = id => document.getElementById(id);
const results = new Map();
let running = false;
function render(){
  const total=[...results.values()].reduce((a,b)=>a+b,0);
  $('total').textContent=total;
  $('instances').textContent=results.size;
  const list=$('distribution');list.replaceChildren();
  if(!total){const p=document.createElement('p');p.className='monitor-note';p.textContent='No measurements yet. Run a probe test to begin.';list.append(p);return;}
  for(const [name,count] of [...results.entries()].sort((a,b)=>b[1]-a[1])){
    const item=document.createElement('div');
    const row=document.createElement('div');row.className='monitor-server';
    const label=document.createElement('strong');label.textContent=name;
    const value=document.createElement('span');value.textContent=`${count} requests · ${(count/total*100).toFixed(1)}%`;
    row.append(label,value);
    const track=document.createElement('div');track.className='monitor-track';
    const fill=document.createElement('div');fill.className='monitor-fill';fill.style.width=`${count/total*100}%`;
    track.append(fill);item.append(row,track);list.append(item);
  }
}
$('run').onclick=async()=>{
 if(running)return;
 running=true;$('run').disabled=true;
 const n=Math.min(100,Math.max(1,Number($('count').value)||20));
 let failures=0;
 try{
  for(let i=0;i<n;i++){
   $('status').textContent=`Testing ${i+1} / ${n}…`;
   const start=performance.now();
   try{
    const response=await fetch('/api/network/instance',{cache:'no-store',headers:{'Accept':'application/json'}});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const data=await response.json();
    if(typeof data.instance!=='string'||!data.instance)throw Error('Missing instance name');
    results.set(data.instance,(results.get(data.instance)||0)+1);
    $('latency').textContent=`${Math.round(performance.now()-start)} ms`;
    render();
   }catch(e){failures++;}
  }
  $('status').textContent=`Completed ${n} probes (${failures} failed). Results are browser samples, not CloudWatch totals.`;
 }finally{running=false;$('run').disabled=false;}
};
$('reset').onclick=()=>{if(running)return;results.clear();$('latency').textContent='—';$('status').textContent='Results cleared';render();};
render();

async function refreshAwsMetrics(){
 const button=$('aws-refresh');button.disabled=true;
 $('aws-status').textContent='Loading AWS target health and CloudWatch metrics…';
 try{
  const res=await fetch('/api/network/aws-metrics',{cache:'no-store'});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const data=await res.json();
  if(!data.connected){
   $('aws-status').textContent=data.error||'AWS metrics are not connected.';
   $('aws-healthy').textContent='—';$('aws-requests').textContent='—';$('aws-latency').textContent='—';
   $('aws-app-health').textContent='';$('aws-details').textContent='';
   return;
  }
  const mon=data.targets.monitor,app=data.targets.application;
  $('aws-status').textContent='Connected to AWS · '+data.region+' · CloudWatch data may lag several minutes.';
  $('aws-healthy').textContent=mon.healthy+' / '+(mon.healthy+mon.unhealthy+mon.other);
  $('aws-requests').textContent=Number(data.request_count).toLocaleString();
  $('aws-latency').textContent=data.target_response_time_ms===null?'No data':data.target_response_time_ms+' ms';
  $('aws-app-health').textContent='Application target group: '+app.healthy+' healthy, '+app.unhealthy+' unhealthy, '+app.other+' other.';
  $('aws-details').textContent='Monitor targets: '+mon.details.map(t=>t.id+': '+t.state+(t.reason?' ('+t.reason+')':'')).join(' · ');
 }catch(e){$('aws-status').textContent='AWS metrics request failed: '+e.message;}
 finally{button.disabled=false;}
}
$('aws-refresh').onclick=refreshAwsMetrics;
refreshAwsMetrics();
