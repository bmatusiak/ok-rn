/**
 * Types for @bmatusiak/rectify.
 *
 * The package is plain CommonJS with no declarations, and this project builds
 * with `strict`, so without these every use is an implicit-any error.
 *
 * Deliberately minimal: it describes what src/onlykey.ts actually uses and
 * nothing more. A wider guess at the API would be a second, unverified copy of
 * Rectify's contract living in an app that only composes five plugins - and
 * unlike node-onlykey-lib's declarations, which are generated from its own
 * JSDoc and cannot drift, this one is hand-written and would.
 */
declare module '@bmatusiak/rectify' {
  /**
   * A started app.
   *
   * `services` holds every provided name EXCEPT those a plugin restricted with
   * setup.allowed - the session key is deliberately absent from it, and that
   * absence is the enforcement, so this type must not pretend otherwise.
   */
  export type RectifyApp = {
    services: Record<string, any>;
    start(): Promise<RectifyApp>;
    destroy(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): void;
  };

  /**
   * Settings ride on the plugin ARRAY, as `plugins.config`, keyed by the
   * service name each plugin provides.
   */
  export type PluginList = any[] & {config?: Record<string, unknown>};

  export function build(
    plugins: PluginList,
    ready?: ((err: Error | null, app: RectifyApp) => void) | Record<string, unknown>,
  ): RectifyApp;

  const Rectify: {
    build: typeof build;
    PluginBase: any;
  };
  export default Rectify;
}
