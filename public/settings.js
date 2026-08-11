(() => {
  const api = '/api/admin/settings'
  const loginView = document.querySelector('#login-view')
  const settingsView = document.querySelector('#settings-view')
  const loginForm = document.querySelector('#login-form')
  const settingsForm = document.querySelector('#settings-form')
  const fieldsRoot = document.querySelector('#fields')
  const infraRoot = document.querySelector('#infrastructure')
  const loginMessage = document.querySelector('#login-message')
  const formMessage = document.querySelector('#form-message')
  const saveState = document.querySelector('#save-state')
  const warning = document.querySelector('#warning')
  const logout = document.querySelector('#logout')
  const saveButton = document.querySelector('#save')

  const setMessage = (element, text = '', kind = '') => {
    element.textContent = text
    element.className = `message${kind ? ` ${kind}` : ''}`
  }

  const request = async (path = '', options = {}) => {
    const response = await fetch(`${api}${path}`, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
    })
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`)
      error.status = response.status
      error.details = body.details
      throw error
    }
    return body
  }

  const fieldElement = (field) => {
    const wrapper = document.createElement('section')
    wrapper.className = 'field'

    const title = document.createElement('div')
    title.className = 'field-title'
    const label = document.createElement('label')
    label.htmlFor = `field-${field.key}`
    label.textContent = `${field.label}${field.required ? ' *' : ''}`
    const source = document.createElement('span')
    source.className = 'source'
    source.dataset.source = field.source
    source.textContent = field.source
    title.append(label, source)

    const description = document.createElement('p')
    description.className = 'field-description'
    description.textContent = field.description

    const input = document.createElement('input')
    input.id = `field-${field.key}`
    input.name = field.key
    input.type = field.secret ? 'password' : field.kind === 'url' ? 'url' : field.kind === 'number' ? 'number' : 'text'
    input.value = field.value || ''
    input.autocomplete = 'off'
    input.required = Boolean(field.required && !field.configured)
    if (field.kind === 'passcode') {
      input.inputMode = 'numeric'
      input.pattern = '\\d{6}'
      input.minLength = 6
      input.maxLength = 6
      input.autocomplete = 'new-password'
      input.placeholder = field.configured ? 'Configured — enter 6 digits to replace' : '6 digits'
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 6)
      })
    }
    if (field.secret) {
      if (field.kind !== 'passcode') {
        input.placeholder = field.configured ? 'Configured — enter a replacement' : 'Not configured'
      }
    }

    wrapper.append(title, description, input)
    if (field.secret) {
      const secretActions = document.createElement('div')
      secretActions.className = 'secret-actions'
      const state = document.createElement('span')
      state.textContent = field.configured ? 'Secret is configured' : 'No secret configured'
      const clearLabel = document.createElement('label')
      const clear = document.createElement('input')
      clear.type = 'checkbox'
      clear.dataset.clear = field.key
      clearLabel.append(clear, document.createTextNode(' Use environment fallback'))
      secretActions.append(state, clearLabel)
      wrapper.append(secretActions)
    }
    return wrapper
  }

  const render = (data) => {
    fieldsRoot.replaceChildren(...data.fields.map(fieldElement))
    infraRoot.replaceChildren(...data.infrastructure.map((item) => {
      const element = document.createElement('div')
      element.className = 'infra-item'
      const name = document.createElement('strong')
      const dot = document.createElement('i')
      dot.className = 'dot'
      name.append(dot, document.createTextNode(item.name))
      const note = document.createElement('span')
      note.textContent = item.note
      element.append(name, note)
      return element
    }))
    warning.textContent = data.warning || ''
    warning.classList.toggle('hidden', !data.warning)
    saveState.textContent = data.updated_at
      ? `Saved ${new Date(data.updated_at).toLocaleString()}`
      : 'Using environment defaults'
    loginView.classList.add('hidden')
    settingsView.classList.remove('hidden')
    logout.classList.remove('hidden')
  }

  // ── Manyfold connect ──────────────────────────────────────────────────────
  // Agents are authorized on Manyfold's own page. This side only ever holds an
  // opaque connectId; the device code and the agent bearers stay on the server.
  const connectApi = '/api/admin'
  const agentsRoot = document.querySelector('#agents')
  const rolesRoot = document.querySelector('#roles')
  const connectBanner = document.querySelector('#connect-banner')
  const connectPending = document.querySelector('#connect-pending')
  const connectCode = document.querySelector('#connect-code')
  const connectOpen = document.querySelector('#connect-open')
  const connectStart = document.querySelector('#connect-start')
  const connectCancel = document.querySelector('#connect-cancel')
  const connectMessage = document.querySelector('#connect-message')

  const POLL_INTERVAL_MS = 2_000
  const EXPIRY_WARNING_MS = 24 * 60 * 60_000
  let pollTimer = null
  let activeConnectId = null

  const adminRequest = async (path, options = {}) => {
    const response = await fetch(`${connectApi}${path}`, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
    })
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
    return body
  }

  const relativeExpiry = (iso) => {
    if (!iso) return 'no expiry'
    const remaining = Date.parse(iso) - Date.now()
    if (!Number.isFinite(remaining)) return 'no expiry'
    if (remaining <= 0) return 'expired'
    const days = Math.floor(remaining / 86_400_000)
    if (days >= 1) return `expires in ${days} day${days === 1 ? '' : 's'}`
    const hours = Math.max(1, Math.round(remaining / 3_600_000))
    return `expires in ${hours} hour${hours === 1 ? '' : 's'}`
  }

  const agentCard = (agent) => {
    const card = document.createElement('div')
    card.className = 'agent-card'
    card.dataset.agent = agent.agentId

    const name = document.createElement('strong')
    const dot = document.createElement('i')
    dot.className = `dot${agent.verified ? '' : ' warn'}`
    name.append(dot, document.createTextNode(agent.name))

    const meta = document.createElement('span')
    meta.className = 'agent-meta'
    meta.textContent = `${agent.verified ? 'verified' : 'not verified'} · ${relativeExpiry(agent.expiresAt)}`

    const description = document.createElement('p')
    description.className = 'agent-description'
    description.textContent = agent.description || agent.warning || ''

    const actions = document.createElement('div')
    actions.className = 'agent-actions'
    const verify = document.createElement('button')
    verify.type = 'button'
    verify.className = 'quiet'
    verify.textContent = 'Re-check'
    verify.addEventListener('click', () => runAgentAction(
      () => adminRequest(`/agents/${encodeURIComponent(agent.agentId)}/verify`, { method: 'POST', body: '{}' }),
      `Re-checked ${agent.name}.`,
    ))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'quiet danger'
    remove.textContent = 'Disconnect'
    remove.addEventListener('click', () => runAgentAction(
      () => adminRequest(`/agents/${encodeURIComponent(agent.agentId)}`, { method: 'DELETE' }),
      `Disconnected ${agent.name}.`,
    ))
    actions.append(verify, remove)

    card.append(name, meta, description, actions)
    return card
  }

  /**
   * One role picker.
   *
   * The host element is rebuilt from scratch on every render rather than
   * mutated: controls.js guards upgrades with data-ui-ready and binds option
   * handlers once, so reusing an upgraded host would leave the new options
   * inert.
   */
  const rolePicker = (role, label, agents, selected) => {
    const row = document.createElement('div')
    row.className = 'role-row'

    const caption = document.createElement('span')
    caption.className = 'role-label'
    caption.textContent = label

    const host = document.createElement('div')
    host.className = 'ui-select role-select'
    host.setAttribute('data-ui-select', '')
    host.dataset.role = role
    host.dataset.value = selected || ''

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ui-select-button'
    button.setAttribute('data-ui-select-button', '')
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-label', `${label} agent`)
    const value = document.createElement('span')
    value.className = 'ui-select-value'
    value.setAttribute('data-ui-select-label', '')
    const caret = document.createElement('span')
    caret.className = 'ui-select-caret'
    button.append(value, caret)

    const list = document.createElement('div')
    list.className = 'ui-select-list'
    list.setAttribute('role', 'listbox')
    list.setAttribute('data-ui-select-list', '')
    list.setAttribute('aria-label', `${label} agent`)
    list.hidden = true
    for (const agent of agents) {
      const option = document.createElement('div')
      option.setAttribute('role', 'option')
      option.dataset.value = agent.agentId
      option.textContent = agent.name
      list.append(option)
    }
    const none = document.createElement('div')
    none.setAttribute('role', 'option')
    none.dataset.value = ''
    none.textContent = '— not assigned —'
    list.append(none)

    host.append(button, list)
    row.append(caption, host)
    return row
  }

  const renderConnect = (state) => {
    const agents = state.agents || []
    const roles = state.roles || {}
    const labels = state.role_labels || {}

    agentsRoot.replaceChildren(...(agents.length
      ? agents.map(agentCard)
      : [Object.assign(document.createElement('p'), {
          className: 'empty',
          textContent: 'No agents connected. Article Lens is serving mock results.',
        })]))

    rolesRoot.replaceChildren(...Object.keys(labels).map(
      (role) => rolePicker(role, labels[role], agents, roles[role]),
    ))
    if (window.UiControls) window.UiControls.upgrade()

    const assigned = new Set(Object.values(roles).filter(Boolean))
    const soonest = agents
      .map((agent) => (agent.expiresAt ? Date.parse(agent.expiresAt) : Infinity))
      .sort((a, b) => a - b)[0]
    const notices = []
    if (agents.length && Object.values(roles).some((id) => !id)) {
      notices.push('Some roles have no agent assigned; those stages will fall back to local output.')
    }
    if (Number.isFinite(soonest) && soonest - Date.now() < EXPIRY_WARNING_MS) {
      notices.push('An agent authorization expires within 24 hours. Reconnect to rotate it.')
    }
    if (assigned.size === 1 && agents.length === 1) {
      // Worth saying plainly: five roles on one agent is a different load
      // profile, and the run has a fixed 12-minute budget either way.
      notices.push('All five roles share one agent, so analyses run slower and may degrade under the time budget.')
    }
    connectBanner.textContent = notices.join(' ')
    connectBanner.classList.toggle('hidden', !notices.length)

    if (state.session) {
      activeConnectId = state.session.connectId
      connectCode.textContent = state.session.userCode
      connectOpen.href = state.session.authUrl
      connectPending.classList.remove('hidden')
      startPolling()
    } else {
      connectPending.classList.add('hidden')
      stopPolling()
    }
  }

  const loadConnect = async () => {
    try {
      renderConnect(await adminRequest('/agents'))
    } catch (error) {
      setMessage(connectMessage, error.message, 'error')
    }
  }

  const runAgentAction = async (action, success) => {
    setMessage(connectMessage, 'Working…')
    try {
      renderConnect(await action())
      setMessage(connectMessage, success, 'success')
    } catch (error) {
      setMessage(connectMessage, error.message, 'error')
    }
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  // Polls serially rather than on an interval: overlapping polls would race to
  // redeem one-time credentials, and only one of them can win.
  function startPolling() {
    stopPolling()
    pollTimer = setTimeout(async () => {
      if (!activeConnectId) return
      try {
        const outcome = await adminRequest(`/connect/${encodeURIComponent(activeConnectId)}/poll`, {
          method: 'POST',
          body: '{}',
        })
        if (outcome.status === 'pending') {
          startPolling()
          return
        }
        activeConnectId = null
        if (outcome.status === 'approved') {
          const failed = outcome.failed || []
          setMessage(
            connectMessage,
            failed.length
              ? `Connected ${outcome.agents.length} agent(s); ${failed.length} refused: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`
              : `Connected ${outcome.agents.length} agent(s).`,
            failed.length ? 'error' : 'success',
          )
          renderConnect(outcome)
        } else {
          setMessage(connectMessage, `Authorization ${outcome.status}.`, 'error')
          await loadConnect()
        }
      } catch (error) {
        activeConnectId = null
        setMessage(connectMessage, error.message, 'error')
        await loadConnect()
      }
    }, POLL_INTERVAL_MS)
  }

  connectStart.addEventListener('click', async () => {
    connectStart.disabled = true
    setMessage(connectMessage, 'Starting…')
    try {
      const session = await adminRequest('/connect', { method: 'POST', body: '{}' })
      activeConnectId = session.connectId
      connectCode.textContent = session.userCode
      connectOpen.href = session.authUrl
      connectPending.classList.remove('hidden')
      window.open(session.authUrl, '_blank', 'noopener')
      setMessage(connectMessage, 'Waiting for approval on Manyfold…')
      startPolling()
    } catch (error) {
      setMessage(connectMessage, error.message, 'error')
    } finally {
      connectStart.disabled = false
    }
  })

  connectCancel.addEventListener('click', async () => {
    stopPolling()
    const id = activeConnectId
    activeConnectId = null
    connectPending.classList.add('hidden')
    setMessage(connectMessage, 'Cancelled.')
    if (id) {
      try { await adminRequest(`/connect/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch {}
    }
  })

  // controls.js dispatches a bubbling `change`, so one delegated listener
  // covers every picker and survives the full re-render on each save.
  rolesRoot.addEventListener('change', async (event) => {
    const host = event.target.closest('[data-ui-select][data-role]')
    if (!host) return
    setMessage(connectMessage, 'Saving roles…')
    const roles = {}
    for (const picker of rolesRoot.querySelectorAll('[data-ui-select][data-role]')) {
      roles[picker.dataset.role] = picker.dataset.value || null
    }
    try {
      renderConnect(await adminRequest('/roles', { method: 'PUT', body: JSON.stringify({ roles }) }))
      setMessage(connectMessage, 'Roles saved.', 'success')
    } catch (error) {
      setMessage(connectMessage, error.message, 'error')
      await loadConnect()
    }
  })

  const load = async () => {
    try {
      const data = await request()
      render(data)
      await loadConnect()
      return true
    } catch (error) {
      if (error.status !== 401) setMessage(loginMessage, error.message, 'error')
      loginView.classList.remove('hidden')
      settingsView.classList.add('hidden')
      logout.classList.add('hidden')
      return false
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = loginForm.querySelector('button')
    button.disabled = true
    setMessage(loginMessage, 'Checking…')
    try {
      await request('/login', {
        method: 'POST',
        body: JSON.stringify({ password: loginForm.password.value }),
      })
      loginForm.reset()
      setMessage(loginMessage)
      await load()
    } catch (error) {
      setMessage(loginMessage, error.message, 'error')
    } finally {
      button.disabled = false
    }
  })

  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    saveButton.disabled = true
    saveState.textContent = 'Saving…'
    setMessage(formMessage)
    const values = Object.fromEntries(new FormData(settingsForm).entries())
    const clear = [...settingsForm.querySelectorAll('[data-clear]:checked')].map((input) => input.dataset.clear)
    try {
      await request('', { method: 'PUT', body: JSON.stringify({ values, clear }) })
      setMessage(formMessage, 'Settings saved. New jobs and requests will use them.', 'success')
      await load()
    } catch (error) {
      const details = Array.isArray(error.details) ? ` ${error.details.join('; ')}` : ''
      setMessage(formMessage, `${error.message}.${details}`, 'error')
      saveState.textContent = 'Save failed'
    } finally {
      saveButton.disabled = false
    }
  })

  logout.addEventListener('click', async () => {
    try { await request('/logout', { method: 'POST', body: '{}' }) } catch {}
    location.reload()
  })

  load()
})()
