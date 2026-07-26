(() => {
  const api = '/api/access'
  const form = document.querySelector('#access-form')
  const passcode = document.querySelector('#passcode')
  const button = document.querySelector('#unlock')
  const message = document.querySelector('#access-message')

  const destination = () => {
    const value = new URLSearchParams(location.search).get('next') || '/'
    return value.startsWith('/') && !value.startsWith('//') ? value : '/'
  }

  const setMessage = (text = '', kind = '') => {
    message.textContent = text
    message.className = `message${kind ? ` ${kind}` : ''}`
  }

  const request = async (path, options = {}) => {
    const response = await fetch(`${api}${path}`, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
    })
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    return body
  }

  passcode.addEventListener('input', () => {
    passcode.value = passcode.value.replace(/\D/g, '').slice(0, 6)
    if (message.classList.contains('error')) setMessage()
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!/^\d{6}$/.test(passcode.value)) {
      setMessage('Enter all 6 digits.', 'error')
      passcode.focus()
      return
    }
    button.disabled = true
    setMessage('Checking access code…')
    try {
      await request('/login', {
        method: 'POST',
        body: JSON.stringify({ passcode: passcode.value }),
      })
      location.replace(destination())
    } catch (error) {
      setMessage(error.message, 'error')
      passcode.select()
    } finally {
      button.disabled = false
    }
  })

  request('/status')
    .then((status) => {
      if (status.authenticated) {
        location.replace(destination())
      } else if (!status.configured) {
        setMessage('Access is not configured yet. Ask an administrator to open Settings.', 'error')
        passcode.disabled = true
        button.disabled = true
      } else if (!status.ready) {
        setMessage('Access sessions are not configured correctly. Ask an administrator to check Settings.', 'error')
        passcode.disabled = true
        button.disabled = true
      }
    })
    .catch((error) => setMessage(error.message, 'error'))
})()
