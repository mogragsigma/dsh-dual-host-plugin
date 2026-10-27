// Setup identity is distinct from enabling the business gateway. Never infer
// local/cloud from the operating system, browser URL, SSH username or nickname.
export function onboardingIdentity(config={}) {
 const gateway=config.role,setup=config.onboarding?.role;
 for(const role of [gateway,setup])if(role!==undefined&&!['local','cloud'].includes(role))throw Error('ONBOARDING_IDENTITY_INVALID');
 if(gateway&&setup&&gateway!==setup)throw Error('ONBOARDING_IDENTITY_CONFLICT');
 const role=gateway??setup??'unassigned';
 return {role,name:role==='cloud'?'云端大肥鱼':role==='local'?'本地大肥鱼':'尚未分配双端角色的 DSH',source:gateway?'gateway_configuration':setup?'setup_configuration':'unassigned'};
}
