import {Temporal} from '@js-temporal/polyfill';
const DAY=86400000,YEAR=366*DAY;
const invalid=()=>{throw Error('SCHEDULER_RULE_INVALID');};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))invalid();};
const timestamp=v=>{if(typeof v==='string'){try{if(v.length>50)invalid();return Temporal.Instant.from(v).epochMilliseconds;}catch{invalid();}}return v;};
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)invalid();return v;};
export function validateTiming(value,now){
 exact(value,['rule','end_at','max_occurrences','max_runs']);
 const end_at=integer(timestamp(value.end_at),now+1,now+YEAR),max_occurrences=integer(value.max_occurrences,1,366),max_runs=integer(value.max_runs,1,10);
 const r=value.rule;exact(r,['kind','at','every_seconds','start_at','weekday','hour','minute','timezone','name']);
 let rule;
 if(r.kind==='once'){exact(r,['kind','at']);rule={kind:'once',at:integer(timestamp(r.at),now,end_at-1)};if(max_occurrences!==1)invalid();}
 else if(r.kind==='interval'){exact(r,['kind','start_at','every_seconds']);rule={kind:'interval',start_at:integer(timestamp(r.start_at),now,end_at-1),every_seconds:integer(r.every_seconds,60,366*86400)};}
 else if(r.kind==='weekly'){
  exact(r,['kind','start_at','weekday','hour','minute','timezone']);
  rule={kind:'weekly',start_at:integer(timestamp(r.start_at),now,end_at-1),weekday:integer(r.weekday,1,7),hour:integer(r.hour,0,23),minute:integer(r.minute,0,59),timezone:r.timezone};
  if(typeof r.timezone!=='string'||r.timezone.length>80||!(r.timezone==='UTC'||r.timezone.includes('/')))invalid();
  try{Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(r.timezone);}catch{invalid();}
 }else if(r.kind==='event'){
  exact(r,['kind','name']);if(typeof r.name!=='string'||!r.name.trim()||r.name.length>100)invalid();rule={kind:'event',name:r.name};
 }else invalid();
 return {rule,end_at,max_occurrences,max_runs};
}
function weeklyAt(date,r){
 // Explicit, portable DST policy: nonexistent time moves forward; repeated time uses its first occurrence.
 return Temporal.ZonedDateTime.from({timeZone:r.timezone,year:date.year,month:date.month,day:date.day,hour:r.hour,minute:r.minute},{disambiguation:'compatible'}).epochMilliseconds;
}
export function firstDue(rule){
 if(rule.kind==='event')return null;
 if(rule.kind==='once')return rule.at;
 if(rule.kind==='interval')return rule.start_at;
 const local=Temporal.Instant.fromEpochMilliseconds(rule.start_at).toZonedDateTimeISO(rule.timezone);
 let date=local.toPlainDate().add({days:(rule.weekday-local.dayOfWeek+7)%7}),due=weeklyAt(date,rule);
 if(due<rule.start_at)due=weeklyAt(date.add({weeks:1}),rule);
 return due;
}
function nextWeekly(due,rule){const date=Temporal.Instant.fromEpochMilliseconds(due).toZonedDateTimeISO(rule.timezone).toPlainDate();return weeklyAt(date.add({weeks:1}),rule);}
export function coalesceDue(rule,due,now,end_at){
 if(due===null||due>now||due>=end_at)return null;
 if(rule.kind==='once')return {due,next_due:null,skipped:0};
 const latest=Math.min(now,end_at-1);
 if(rule.kind==='interval'){const skipped=Math.floor((latest-due)/(rule.every_seconds*1000));due+=skipped*rule.every_seconds*1000;return {due,next_due:due+rule.every_seconds*1000,skipped};}
 let next_due=nextWeekly(due,rule),skipped=0;
 while(next_due<=latest){due=next_due;next_due=nextWeekly(due,rule);if(++skipped>54)throw Error('SCHEDULER_TIME_RANGE_INVALID');}
 return {due,next_due,skipped};
}
