// Filesystem fixture only: the parent makes an empty .git directory, NOT a Git repository.
import {DeliveryGitLease} from '../bundle/delivery-commit.js';
const [identity,tag]=process.argv.slice(2),records={};
const lease=new DeliveryGitLease(JSON.parse(identity),JSON.parse(tag),(name,value)=>records[name]=value);
lease.open();process.stdout.write(JSON.stringify(records),()=>process.exit(17)); // OS closes FDs; leave only test lock files.
