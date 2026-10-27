// Fixed own-bundle remove; not an arbitrary package or filesystem interface.
import {createOnboardingSelfLifecycle} from './onboarding-self-lifecycle.js';
export const createOnboardingSelfRemove=options=>createOnboardingSelfLifecycle('remove',options);
