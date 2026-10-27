import React,{useState} from 'react';
import {Button} from './components';
import {SelfDisable} from './self-disable';
import {SelfRemove} from './self-remove';
import {SelfStop} from './self-stop';
export function SelfLifecycle({request,disableContract=0,removeContract=0,stopContract=0,allowStop=false}){
 const [mode,setMode]=useState(disableContract===1?'disable':removeContract===1?'remove':'stop');
 if(disableContract!==1&&removeContract!==1&&stopContract!==1)return null;
 return <section className="connection-panel self-lifecycle-panel" aria-label="本端维护"><div className="connection-actions" role="group" aria-label="本端维护类型">{disableContract===1&&<Button kind={mode==='disable'?'soft':'secondary'} aria-pressed={mode==='disable'} onClick={()=>setMode('disable')}>停用插件</Button>}{removeContract===1&&<Button kind={mode==='remove'?'soft':'secondary'} aria-pressed={mode==='remove'} onClick={()=>setMode('remove')}>移除插件包</Button>}{stopContract===1&&<Button kind={mode==='stop'?'soft':'secondary'} aria-pressed={mode==='stop'} onClick={()=>setMode('stop')}>停止本端 Host</Button>}</div><p className="fine-print">停用保留安装包；移除需另有可重装包源。停机是独立动作，三者都不清空数据。切换或关闭不会撤销已提交操作。</p>{mode==='disable'?<SelfDisable request={request} contract={disableContract}/>:mode==='remove'?<SelfRemove request={request} contract={removeContract}/>:<SelfStop request={request} contract={stopContract} allowStop={allowStop}/>}</section>;
}
