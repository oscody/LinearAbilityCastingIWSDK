import { ParticleEngine } from '../particles/ParticleEngine.js';
import { ParticleSystemV2 } from './ParticleSystemV2.js';

/** Only ice.mist uses the V2 copy; all other particle systems stay original. */
export class ParticleEngineV2 extends ParticleEngine {
  constructor(scene) {
    super(scene);
    this.mistV2 = false;
  }

  get(name, options) {
    if (name !== 'ice.mist') return super.get(name, options);
    let system = this.systems.get(name);
    if (!system) {
      system = new ParticleSystemV2({ name, ...options });
      system.uniforms.uMistV2.value = this.mistV2 ? 1 : 0;
      this.systems.set(name, system);
      this.scene.add(system.object3D);
    }
    return system;
  }

  setMistV2(enabled) {
    this.mistV2 = enabled;
    const mist = this.systems.get('ice.mist');
    if (mist) mist.uniforms.uMistV2.value = enabled ? 1 : 0;
  }
}
