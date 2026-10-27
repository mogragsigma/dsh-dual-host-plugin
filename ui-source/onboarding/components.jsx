import React,{useEffect,useRef,useId,useContext,createContext} from 'react';
import {ArrowRight,Check,Cloud,Monitor,KeyRound,ShieldCheck,MessagesSquare,FolderGit2,ChevronDown,Info,Link,LoaderCircle,CheckCircle2,AlertTriangle,FileText,Folder,ArrowUpRight,X,Pause,Play,RotateCcw,Settings2,Lock,ChevronLeft,Save,Terminal,Plus,Download,Unplug,Copy,ChevronRight,CircleHelp} from 'lucide-react';
import {fieldHelp,featureHelp,requirementLabels} from './field-help';
const HelpContext=createContext(null);
export function HelpProvider({onHelp,children}){return <HelpContext.Provider value={onHelp}>{children}</HelpContext.Provider>;}
const icons={arrow:ArrowRight,check:Check,cloud:Cloud,monitor:Monitor,key:KeyRound,shield:ShieldCheck,chat:MessagesSquare,git:FolderGit2,down:ChevronDown,info:Info,link:Link,spinner:LoaderCircle,success:CheckCircle2,warning:AlertTriangle,file:FileText,folder:Folder,external:ArrowUpRight,close:X,pause:Pause,play:Play,reset:RotateCcw,settings:Settings2,lock:Lock,back:ChevronLeft,save:Save,terminal:Terminal,plus:Plus,download:Download,offline:Unplug,copy:Copy,chevron:ChevronRight,help:CircleHelp};
export function Icon({name,...props}){const I=icons[name]||Info;return <I aria-hidden="true" strokeWidth={1.7} {...props}/>;}
export function Mascot({pose='welcome',className=''}){return <div aria-hidden="true" className={'companion '+className} data-pose={pose}/>;}
export function Badge({children,tone=''}){return <span className={'badge '+tone}>{children}</span>;}
export function Button({children,icon,end,kind='',...rest}){return <button type="button" className={'button '+kind} {...rest}>{icon&&<Icon name={icon}/>}<span>{children}</span>{end&&<Icon name={end}/>}</button>;}
export function RequirementBadge({kind}){return <span className={'requirement-badge '+kind}>{kind==='required'&&<span aria-hidden="true">*</span>}{requirementLabels[kind]}</span>;}
export function HelpButton({label,meta=fieldHelp[label]}){
 const show=useContext(HelpContext);
 if(!meta)return null;
 return <button type="button" className="field-help-button" aria-label={label+'填写说明'} aria-haspopup="dialog" title={'了解'+label} onClick={()=>show?.(label+' · 填写说明',<><div className="help-intro"><RequirementBadge kind={meta.kind}/><span>{meta.kind==='required'?'缺少此项，无法继续':meta.kind==='conditional'?'功能可选；启用后需要补齐':meta.kind==='auto'?'系统识别，无需手工填写':'可跳过，或保留默认值'}</span></div><dl className="help-facts"><div><dt>填写什么</dt><dd>{meta.what}</dd></div><div><dt>从哪里获取</dt><dd>{meta.where}</dd></div>{meta.example&&<div><dt>填写示例</dt><dd><code>{meta.example}</code></dd></div>}<div className="help-impact"><dt>不填会怎样</dt><dd>{meta.impact}</dd></div></dl><p className="help-preview-note">普通表单只填引用；Key 只在独立密码框填写并确认保存。规则与 Skill 安装仍需第 5 页独立确认。</p></>)}><Icon name="help"/></button>;
}
export function InfoHelp({title,children}){
 const show=useContext(HelpContext);
 return <button type="button" className="field-help-button section-help" aria-label={title+'说明'} aria-haspopup="dialog" onClick={()=>show?.(title,children)}><Icon name="help"/></button>;
}
export function Panel({title,sub,icon,children,className='',extra}){
 const meta=Object.values(featureHelp).find(m=>m.label===title);
 return <section className={'panel '+className}>{title&&<header className="panel-heading"><div><div className="panel-title-line"><h2>{icon&&<Icon name={icon}/>} {title}</h2>{meta&&<div className="field-markers"><RequirementBadge kind={meta.kind}/><HelpButton label={title} meta={{...meta,what:sub?<>{meta.what}<p>{sub}</p></>:meta.what}}/></div>}{sub&&!meta&&<InfoHelp title={title||"本节"}>{sub}</InfoHelp>}</div></div>{extra}</header>}{children}</section>;
}
export function Field({label,hint,children,...props}){
 const id=useId(),meta=fieldHelp[label];
 const required=meta?.kind==='required'||meta?.kind==='conditional';
 const control=children||<input {...props}/>;
 return <div className="field" data-requirement={meta?.kind}><div className="field-heading"><label htmlFor={id}>{label}</label>{meta&&<div className="field-markers"><RequirementBadge kind={meta.kind}/><HelpButton label={label} meta={meta}/></div>}</div>{React.cloneElement(control,{id,required, 'aria-required':required||undefined,'aria-describedby':hint?id+'-hint':undefined})}{hint&&<small id={id+'-hint'}>{hint}</small>}</div>;
}
export function CheckRow({checked,onChange,title,sub,disabled=false}){
 const meta=fieldHelp[title];
 return <div className="check-controls"><label className={'check-row '+(disabled?'disabled':'')}><input type="checkbox" checked={checked} disabled={disabled} required={meta?.kind==='required'} onChange={e=>onChange(e.target.checked)}/><span><strong>{title}</strong>{sub&&<small>{sub}</small>}</span></label>{meta&&<div className="field-markers"><RequirementBadge kind={meta.kind}/><HelpButton label={title} meta={{...meta,what:sub?<>{meta.what}<p>{sub}</p></>:meta.what}}/></div>}</div>;
}
export function Toggle({label,checked,onChange}){return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={'toggle '+(checked?'on':'')} onClick={()=>onChange(!checked)}><span/></button>;}
export function Callout({children,tone='',title}){return <div className={'callout '+tone}><Icon name={tone==='warn'?'warning':'info'}/><div>{title&&<strong>{title}</strong>}{children}</div></div>;}
export function Summary({pose='welcome',title,children}){
 const show=useContext(HelpContext);
 return <div className="context-help mascot-zone"><Mascot pose={pose}/><button type="button" className="context-help-trigger" aria-haspopup="dialog" onClick={()=>show?.(title,<div className="context-body">{children}<div className="summary-foot"><Icon name="shield"/><span>未批准不执行 · 以实际回执为准</span></div></div>)}><Icon name="help"/><span>{title}</span></button></div>;
}
export function InfoRow({label,value,status}){return <div className="info-row"><span>{label}</span><strong>{status&&<Icon name={status}/>} {value}</strong></div>;}
export function Modal({modal,onClose}){const ref=useRef(),open=!!modal;useEffect(()=>{if(open){ref.current.showModal();return()=>ref.current?.close();}},[open]);return <dialog ref={ref} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><header><div><span className="eyebrow">{modal?.eyebrow??'配置导览 · 字段说明'}</span><h2>{modal?.title}</h2></div><button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close"/></button></header><div className="modal-body">{modal?.body}</div><footer><Button kind="primary" onClick={onClose}>{modal?.closeLabel??'知道了'}</Button></footer></dialog>;}
