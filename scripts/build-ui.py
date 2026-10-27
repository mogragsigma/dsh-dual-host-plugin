"""Compile the accepted preview style into a strictly scoped DSH client module."""
from pathlib import Path
import json,re
import tinycss2
r=Path(__file__).resolve().parents[1]
source=r/'ui-source/approved-v2.css'
def scoped_selector(s):
 s=s.strip()
 if '.native-' in s or s.startswith(('.brand','.app-shell')):return None
 if s==':root':return '.dtu'
 if s.startswith('body.keyboard'):return s.replace('body.keyboard','.dtu.keyboard',1)
 if s=='body':return '.dtu'
 if s.startswith('main'):return '.dtu .surface'+s[4:]
 return '.dtu '+s

def transform(rules):
 out=[]
 for rule in rules:
  if rule.type=='qualified-rule':
   sels=[scoped_selector(x) for x in tinycss2.serialize(rule.prelude).split(',')]
   sels=[x for x in sels if x]
   if sels:out.append(','.join(sels)+'{'+tinycss2.serialize(rule.content)+'}')
  elif rule.type=='at-rule' and rule.content is not None:
   name=rule.lower_at_keyword;pre=tinycss2.serialize(rule.prelude)
   if name=='keyframes':out.append('@keyframes '+pre+'{'+tinycss2.serialize(rule.content)+'}')
   else:
    if name=='media' and 'max-width' in pre:name='container'
    out.append('@'+name+' '+pre+'{'+transform(tinycss2.parse_rule_list(rule.content))+'}')
 return '\n'.join(out)
css=transform(tinycss2.parse_stylesheet(source.read_text(),skip_comments=True,skip_whitespace=True))
css=css.replace("url(\"assets/whale-ui-states.png\")",'var(--mascot,none)').replace("url('assets/whale-ui-states.png')",'var(--mascot,none)')
for n in ['view-in','popover-in','modal-in','toast-in','refresh-turn']:css=css.replace(n,'dtu-'+n)
css+='\n'+(r/'ui-source/overrides.css').read_text()
(r/'ui-source/workbench.scoped.css').write_text(css+'\n')
def onboard_selector(s):
 s=s.strip()
 if s in (':root','body'):return '.dsh-onboarding'
 if s.startswith('body.keyboard'):return s.replace('body.keyboard','.dsh-onboarding.keyboard',1)
 if s.startswith('.keyboard'):return s.replace('.keyboard','.dsh-onboarding.keyboard',1)
 return '.dsh-onboarding '+s
original_selector=scoped_selector
scoped_selector=onboard_selector
onboarding_css=transform(tinycss2.parse_stylesheet((r/'ui-source/onboarding/tokens.css').read_text()+'\n'+(r/'ui-source/onboarding/style.css').read_text(),skip_comments=True,skip_whitespace=True))
onboarding_css=onboarding_css.replace('url("assets/whale-ui-states.png")','var(--mascot,none)').replace("url('assets/whale-ui-states.png')",'var(--mascot,none)')
for name in ['view-in','page-in','dialog-in','popover-in','modal-in','toast-in','spin']:onboarding_css=re.sub(r'(?<![\w-])'+re.escape(name)+r'(?![\w-])','onboarding-'+name,onboarding_css)
onboarding_css+='\n.dsh-onboarding{container-type:inline-size;min-width:0;width:100%;height:100%;overflow:auto;--ease-out:cubic-bezier(.23,1,.32,1)}\n.dsh-onboarding .plan-item{overflow-wrap:anywhere}\n.dsh-onboarding .window-header{height:auto;min-height:70px;flex-wrap:wrap;padding-top:12px;padding-bottom:12px}\n.dsh-onboarding .wizard-footer>.check-controls{grid-column:1/-1;flex-basis:100%}\n'
css+='\n'+onboarding_css
js=(r/'ui-source/workbench-client.js').read_text().replace('/*STYLE*/""',json.dumps(css,ensure_ascii=False)).replace('/*LABELS*/',(r/'ui-source/labels.js').read_text()).replace('/*ONBOARDING*/',(r/'ui-source/onboarding.generated.js').read_text())
js=js.replace('/*ARTIFACT_DOWNLOAD_CLIENT*/',(r/'ui-source/artifact-download-client.mjs').read_text().replace('export async function ','async function ').replace('export function ','function '))
js=js.replace('/*APPROVAL_WORKBENCH_CLIENT*/',(r/'ui-source/approval-workbench-client.mjs').read_text().replace('export function ','function '))
js=js.replace('/*TASK_FOCUS*/',(r/'ui-source/task-focus.mjs').read_text().replace('export function ','function ')).replace('/*TASK_FOCUS_VIEW*/',(r/'ui-source/intervention-action-view.js').read_text()+'\n'+(r/'ui-source/task-focus-view.js').read_text())
(r/'bundle/workbench-client.js').write_text(js)
print('Compiled own scoped workbench UI; no installed files changed.')
