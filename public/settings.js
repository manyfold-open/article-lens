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

  const load = async () => {
    try {
      render(await request())
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
