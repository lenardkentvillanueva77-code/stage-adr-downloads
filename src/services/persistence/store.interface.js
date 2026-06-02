'use strict';

/**
 * services/persistence/store.interface.js
 *
 * Documents the interface that any persistence store must implement.
 * This is not an abstract class — JavaScript doesn't enforce interfaces.
 * This file exists as a contract specification for:
 *   - localStore.js (Phase 1 & 2 — disk-based)
 *   - cloudStore.js (Phase 3 — API-based, to be written)
 *
 * Any store implementation must export:
 *
 *   writeProject(project: object, filePath: string): Promise<WriteResult>
 *   readProject(filePath: string): Promise<ReadResult>
 *
 * Where:
 *
 *   WriteResult = { success: true } | { success: false, error: string }
 *
 *   ReadResult  = {
 *     success: true,
 *     project: object,
 *     migrationsApplied: string[],
 *     warnings: string[],
 *   } | {
 *     success: false,
 *     error: string,
 *   }
 *
 * Notes for cloudStore.js implementors:
 *
 *   - filePath in the cloud context will be a project URL or UUID,
 *     not a filesystem path. The ipc/projectHandlers.js layer abstracts
 *     which store is active so the rest of the app doesn't care.
 *
 *   - The cloud store should use the same project UUIDs as local.
 *     Projects created locally carry their projectId to the cloud — no re-keying.
 *
 *   - The cloud store should run the same migrateProject() from
 *     core/schemaVersion.js on ingestion to handle version drift between
 *     locally-created and server-stored projects.
 *
 *   - syncStatus on takes ('local' | 'pending' | 'synced') is managed
 *     by the cloud store. localStore always writes 'local'.
 */

// This file intentionally exports nothing.
// It is a specification document only.
