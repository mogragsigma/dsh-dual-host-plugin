// Test-only explicit port allocation. The isolated launcher must separately admit
// these free loopback ports; no product network protection is relaxed.
let serial=0;
export function testPort(offset=0){
 const raw=process.env.DSH_TEST_PORT_BASE;if(raw===undefined)return 0;
 const port=Number(raw)+offset+serial++;
 if(!/^\d+$/.test(raw)||!Number.isInteger(port)||port<1024||port>65535)throw Error('TEST_PORT_INVALID');
 return port;
}
