import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { harnessEnvironment } from './process.js';
import type { AgentRunRequest, FailureCode } from './types.js';

export const codexVersion = '0.166.0';
export const codexDefaultModel = 'gpt-6.1-sol';
/** The level a turn uses when the person chose none. */
export const codexDefaultEffort = 'low';
const disabledFeatures = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'memories', 'multi_agent', 'multi_agent_v2',
  'goals', 'view_image', 'image_generation', 'computer_use', 'browser_use', 'in_app_browser', 'shell_snapshot',
  'sleep_tool', 'tool_suggest', 'skill_search', 'hooks', 'code_mode', 'code_mode_host', 'code_mode_only',
  'request_permissions_tool', 'default_mode_request_user_input', 'workspace_dependencies', 'skill_mcp_dependency_install',
];

/** A model catalog is necessary. This CLI lets provider metadata enable native tools independently of feature flags. */
export function codexCatalog(model: string) {
  return { models: [{
    slug: model, display_name: model, description: 'Paso board assistant',
    // The levels a message may pick (`effortLevels.codex`). Without one, a turn uses the default.
    default_reasoning_level: codexDefaultEffort, supported_reasoning_levels: [
      { effort: 'low', description: 'Brief board edits' }, { effort: 'medium', description: 'Balanced' },
      { effort: 'high', description: 'Deeper reasoning' }, { effort: 'xhigh', description: 'Deepest reasoning' },
    ],
    shell_type: 'disabled', visibility: 'list', supported_in_api: true, priority: 0,
    base_instructions: 'Eres el asistente de Paso. Solo puedes usar las herramientas del tablero. Responde en español.',
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, truncation_policy: { mode: 'tokens', limit: 10_000 },
    experimental_supported_tools: [], input_modalities: ['text', 'image'], supports_search_tool: false,
    node_repl_disabled: true, tool_mode: 'direct', multi_agent_version: null,
  }] };
}

export function codexConfiguration(catalogPath: string) {
  return {
    ...Object.fromEntries(disabledFeatures.map((name) => [`features.${name}`, false])),
    forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file',
    model_catalog_json: catalogPath, approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled',
    project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
    'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false,
    'skills.include_instructions': false, 'memories.use_memories': false, 'memories.generate_memories': false,
    'analytics.enabled': false, 'feedback.enabled': false,
    'shell_environment_policy.inherit': 'none',
  };
}

/** No credential contents are read or copied. The CLI follows this link and manages its own login. */
export async function prepareCodex(request: AgentRunRequest, source: NodeJS.ProcessEnv = process.env) {
  const home = join(dirname(request.workDir), 'codex-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const homeStat = await lstat(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error('unsafe_configuration');
  for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md']) {
    const exists = await lstat(join(home, name)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw new Error('unsafe_configuration');
  }
  const loginHome = resolve(source.CODEX_HOME ?? join(homedir(), '.codex'));
  const auth = join(home, 'auth.json');
  try { await symlink(join(loginHome, 'auth.json'), auth); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readlink(auth) !== join(loginHome, 'auth.json')) throw new Error('unsafe_configuration');
  }
  // One catalog per model avoids races between sessions using different models.
  const model = request.model ?? codexDefaultModel;
  const catalogPath = join(home, `model-${Buffer.from(model).toString('hex')}.json`);
  const tempCatalog = join(home, `.model-${randomUUID()}.tmp`);
  try {
    await writeFile(tempCatalog, JSON.stringify(codexCatalog(model)), { mode: 0o600, flag: 'wx' });
    await rename(tempCatalog, catalogPath);
  } finally { await unlink(tempCatalog).catch(() => {}); }
  const config = codexConfiguration(catalogPath);
  return {
    model, config, cwd: await realpath(request.workDir),
    args: ['app-server', '--listen', 'stdio://', '--strict-config', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
    env: harnessEnvironment({ CODEX_HOME: home }, source),
  };
}

export function codexFailureMessage(code: FailureCode) {
  const detail: Partial<Record<FailureCode, string>> = {
    not_installed: 'No se ha encontrado Codex.', signed_out: 'Inicia sesión con «codex login» en una terminal y vuelve a intentarlo.',
    quota: 'Has alcanzado el límite de uso de tu cuenta de Codex.', model_unavailable: 'El modelo pedido no está disponible con tu cuenta de Codex.',
    unsupported_version: `Esta integración necesita Codex CLI ${codexVersion}.`,
    unsafe_configuration: 'Codex ofreció herramientas o permisos ajenos al tablero. Se ha detenido la ejecución.',
    board_unavailable: 'No se pudieron iniciar las herramientas del tablero.',
    protocol: 'Codex devolvió una respuesta que Paso no entiende.', crashed: 'Codex se cerró de forma inesperada.',
    timeout: 'Codex dejó de responder y se ha detenido.',
  };
  return detail[code] ?? 'Codex terminó con un error.';
}
export function classifyCodexFailure(text: string): FailureCode {
  if (/unauthorized|not logged in|login required|authentication|token.*expired|401/i.test(text)) return 'signed_out';
  if (/usageLimitExceeded|rate.?limit|usage limit|quota|429|credits/i.test(text)) return 'quota';
  if (/modelNotFound|model.*(not supported|not found|not available|unavailable|does not exist|no access)/i.test(text)) return 'model_unavailable';
  if (/unknown (option|argument|variant)|unrecognized|unexpected argument|invalid params|method not found/i.test(text)) return 'unsupported_version';
  return 'harness_error';
}
