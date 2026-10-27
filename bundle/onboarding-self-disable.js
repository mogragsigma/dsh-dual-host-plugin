// Fixed own-bundle disable; not an arbitrary package or filesystem interface.
import {createOnboardingSelfLifecycle} from './onboarding-self-lifecycle.js';
export const createOnboardingSelfDisable=options=>createOnboardingSelfLifecycle('disable',options);
