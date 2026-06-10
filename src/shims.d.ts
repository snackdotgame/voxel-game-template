// Type shims for noa-engine's untyped transitive dependencies, so the
// EventEmitter/ECS base classes in noa's declarations resolve.
declare module "events";
declare module "ent-comp";
declare module "gl-vec3";

// Shapes for the physics modules the shared sim drives directly.
declare module "aabb-3d" {
  export type Aabb = {
    base: number[];
    max: number[];
    vec: number[];
  };
  const aabb: new (base: number[], vec: number[]) => Aabb;
  export default aabb;
}

declare module "voxel-physics-engine" {
  import type { Aabb } from "aabb-3d";

  export type RigidBody = {
    aabb: Aabb;
    velocity: number[];
    resting: number[];
    inFluid: boolean;
    ratioInFluid: number;
    friction: number;
    restitution: number;
    gravityMultiplier: number;
    autoStep: boolean;
    airDrag: number;
    fluidDrag: number;
    _forces: number[];
    _impulses: number[];
    _sleepFrameCount: number;
    applyForce(f: number[]): void;
    applyImpulse(i: number[]): void;
    atRestY(): number;
  };

  export type PhysicsWorld = {
    gravity: number[];
    addBody(
      aabb?: Aabb,
      mass?: number,
      friction?: number,
      restitution?: number,
      gravMult?: number,
      onCollide?: (impacts: number[]) => void,
    ): RigidBody;
    removeBody(body: RigidBody): void;
    tick(dtMs: number): void;
  };

  export const Physics: new (
    opts: object,
    testSolid: (x: number, y: number, z: number) => boolean,
    testFluid: (x: number, y: number, z: number) => boolean,
  ) => PhysicsWorld;
}

declare module "noa-engine/src/components/movement.js" {
  export class MovementState {
    heading: number;
    running: boolean;
    jumping: boolean;
    maxSpeed: number;
    moveForce: number;
    responsiveness: number;
    runningFriction: number;
    standingFriction: number;
    airMoveMult: number;
    jumpImpulse: number;
    jumpForce: number;
    jumpTime: number;
    airJumps: number;
    _jumpCount: number;
    _currjumptime: number;
    _isJumping: boolean;
  }
  export function applyMovementPhysics(dt: number, state: MovementState, body: unknown): void;
}
