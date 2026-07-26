export const PLUGIN_ID = 'cdragon.command-center';
export const POPUP_ENTRYPOINT_ID = 'palette';
export const CONFIG_FILE_NAME = 'commands.json';
export const RUN_LOG_FILE_NAME = 'run.log';
// Config/state paths come from herdr or from the CLI; bound them so a hostile or
// corrupted value can never be spliced into a spawn.
export const MAX_PATH_BYTES = 16_384;
