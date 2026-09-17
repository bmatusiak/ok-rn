/**
 * One import path for the request shape.
 *
 * EXPERIMENT - see REMOVAL.md.
 *
 * The spec file is the source of truth (codegen reads it), but it lives outside
 * src/, so re-exporting here keeps every file under src/credprovider/ importing
 * from one place and makes the removal a directory delete.
 */
export type {PendingCredRequest} from '../../specs/NativeCredProvider';
