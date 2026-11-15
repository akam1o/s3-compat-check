import { isOwnedKey } from "./config.js";

interface TrackedObject {
  owner: string;
  /** Version ids observed for this key (versioned buckets only). */
  versions: Set<string>;
  /** Whether the "current" object has been removed (unversioned buckets). */
  deleted: boolean;
}

export interface PendingObject {
  key: string;
  owner: string;
  versions: string[];
  deleted: boolean;
}

export interface PendingUpload {
  key: string;
  uploadId: string;
  owner: string;
}

/**
 * Records every object and multipart upload a run may have created, so that
 * cleanup only ever touches resources this run owns.
 */
export class ResourceTracker {
  private readonly objects = new Map<string, TrackedObject>();
  private readonly uploads = new Map<string, PendingUpload>();
  /** Set once a PUT returns a version id: the bucket keeps old versions. */
  versioningObserved = false;

  constructor(readonly runPrefix: string) {}

  owns(key: string): boolean {
    return isOwnedKey(key, this.runPrefix);
  }

  /** Register a key before it is written. Throws for keys outside the run prefix. */
  addObject(key: string, owner: string): void {
    if (!this.owns(key)) throw new Error(`Refusing to track key outside the run prefix`);
    const existing = this.objects.get(key);
    if (existing) {
      existing.deleted = false;
    } else {
      this.objects.set(key, { owner, versions: new Set(), deleted: false });
    }
  }

  /**
   * Record a version id returned by a write or delete. The literal "null" is
   * kept too: on versioning-suspended buckets it identifies the null version
   * or a null delete marker, which a plain DELETE would not remove.
   */
  addVersion(key: string, versionId: string | undefined): void {
    const obj = this.objects.get(key);
    if (!obj || !versionId) return;
    obj.versions.add(versionId);
    this.versioningObserved = true;
  }

  markDeleted(key: string, versionId?: string): void {
    const obj = this.objects.get(key);
    if (!obj) return;
    if (versionId) {
      obj.versions.delete(versionId);
      // Every version this run created is gone, so the key no longer exists.
      if (obj.versions.size === 0) obj.deleted = true;
    } else {
      obj.deleted = true;
    }
  }

  addUpload(key: string, uploadId: string, owner: string): void {
    if (!this.owns(key)) throw new Error(`Refusing to track upload outside the run prefix`);
    this.uploads.set(uploadId, { key, uploadId, owner });
  }

  removeUpload(uploadId: string): void {
    this.uploads.delete(uploadId);
  }

  pendingObjects(owner?: string): PendingObject[] {
    const out: PendingObject[] = [];
    for (const [key, obj] of this.objects) {
      if (owner !== undefined && obj.owner !== owner) continue;
      if (obj.deleted && obj.versions.size === 0) continue;
      out.push({ key, owner: obj.owner, versions: [...obj.versions], deleted: obj.deleted });
    }
    return out;
  }

  pendingUploads(owner?: string): PendingUpload[] {
    return [...this.uploads.values()].filter((u) => owner === undefined || u.owner === owner);
  }

  get trackedObjectCount(): number {
    return this.objects.size;
  }
}
