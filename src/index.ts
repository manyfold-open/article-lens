import { CORS_HEADERS } from './http'
import {
  guardArticleAccess,
  handleArticleAccess,
  handleAdminSettings,
  isArticleAccessPagePath,
  isArticleAccessPath,
  isArticleAccessProtectedPath,
  isAdminSettingsPath,
  resolveRuntimeEnv,
} from './admin/settings'
import { handleAnalyze, handleAnalysisStatus, handleCreateAnalysis } from './routes/analyze'
import { handleDefine } from './routes/define'
import { handleFrontPage } from './routes/frontpage'
import { handleHealth } from './routes/health'
import type { Env } from './schema'
import { handleAnalysisTaskBatch } from './workflow/analysis-task'

export { AnalysisJob } from './workflow/analysis-job'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (isAdminSettingsPath(url.pathname)) {
      return handleAdminSettings(request, env)
    }
    if (url.pathname === '/settings' || url.pathname === '/settings/') {
      return env.ASSETS.fetch(request)
    }
    if (isArticleAccessPath(url.pathname)) {
      return handleArticleAccess(request, env)
    }
    if (isArticleAccessPagePath(url.pathname)) {
      return env.ASSETS.fetch(request)
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    let runtimeEnv = env
    if (isArticleAccessProtectedPath(url.pathname)) {
      const access = await guardArticleAccess(request, env)
      if (access.response) return access.response
      runtimeEnv = access.runtimeEnv
    } else if (url.pathname.startsWith('/api/')) {
      runtimeEnv = await resolveRuntimeEnv(env)
    }
    if (url.pathname === '/api/frontpage' && request.method === 'GET') {
      return handleFrontPage()
    }
    if (url.pathname === '/api/analyze' && request.method === 'GET') {
      return handleAnalyze(url, runtimeEnv)
    }
    if (url.pathname === '/api/analyses' && request.method === 'POST') {
      return handleCreateAnalysis(request, runtimeEnv)
    }
    const analysisStatus = url.pathname.match(/^\/api\/analyses\/([^/]+)\/status$/)
    if (analysisStatus && request.method === 'GET') {
      const afterValue = Number(url.searchParams.get('after') ?? 0)
      const after = Number.isFinite(afterValue) ? afterValue : 0
      return handleAnalysisStatus(runtimeEnv, decodeURIComponent(analysisStatus[1]), after)
    }
    if (url.pathname === '/api/define' && request.method === 'POST') {
      return handleDefine(request, runtimeEnv)
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return handleHealth(url, runtimeEnv)
    }

    return env.ASSETS.fetch(request)
  },

  async queue(
    batch: MessageBatch<import('./workflow/analysis-job').AnalysisQueueMessage>,
    env: Env,
  ): Promise<void> {
    return handleAnalysisTaskBatch(batch, await resolveRuntimeEnv(env))
  },
}
