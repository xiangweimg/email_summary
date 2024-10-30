const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');
const { Anthropic } = require('@anthropic-ai/sdk');
require('dotenv').config();
const express = require('express');
const app = express();
const port = 3000;

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// Debug check for API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Warning: ANTHROPIC_API_KEY not found in environment variables');
}

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

async function listPrimaryInboxMessages(auth) {
  const gmail = google.gmail({version: 'v1', auth});
  
  try {
    // First, get the label ID for CATEGORY_PERSONAL (Primary)
    const labels = await gmail.users.labels.list({
      userId: 'me'
    });
    
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'], // Combines UNREAD, Primary category, and INBOX
      q: 'is:unread category:primary in:inbox' // Additional query to ensure we get primary inbox emails
    });
    
    return res.data.messages || [];
  } catch (error) {
    console.error('Error fetching primary inbox messages:', error);
    throw error;
  }
}

async function getMessage(auth, messageId) {
  const gmail = google.gmail({version: 'v1', auth});
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });
  return res.data;
}

function getEmailBody(payload) {
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain') {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) {
        const body = getEmailBody(part);
        if (body) return body;
      }
    }
  } else if (payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  return '';
}

function getEmailDetails(message) {
  const headers = message.payload.headers;
  const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
  const from = headers.find(h => h.name === 'From')?.value || 'No Sender';
  const date = headers.find(h => h.name === 'Date')?.value || 'No Date';
  
  return {
    subject,
    from,
    date: new Date(date).toLocaleString()
  };
}

async function summarizeEmail(emailBody) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured in environment variables');
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  try {
    console.log('Making API call to Anthropic...');
    const completion = await anthropic.messages.create({
      model: "claude-2.1",
      max_tokens: 300,
      system: "You are a helpful assistant that creates clear and concise email summaries in bullet points. Focus on key information, action items, and important details.",
      messages: [
        {
          role: "user",
          content: `Please summarize the key points of this email in bullet point format. Include:
- Main topic/purpose
- Key details
- Any action items or deadlines
- Important dates or numbers (if any)

Email content:
${emailBody}`
        }
      ]
    });

    console.log('API call successful');
    return completion.content[0].text;
  } catch (error) {
    console.error('Error details:', {
      message: error.message,
      type: error.type,
      response: error.response?.data
    });
    throw error;
  }
}

// Store summaries in memory
const summaries = [];

// HTML endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Primary Inbox Email Summaries</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                line-height: 1.6;
                background-color: #f5f5f5;
            }
            .summary-card {
                border: 1px solid #ddd;
                padding: 20px;
                margin: 15px 0;
                border-radius: 8px;
                background-color: #fff;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .email-header {
                margin-bottom: 15px;
                padding-bottom: 10px;
                border-bottom: 1px solid #eee;
            }
            .subject {
                font-weight: bold;
                font-size: 1.1em;
                color: #2c3e50;
                margin-bottom: 5px;
            }
            .meta-info {
                font-size: 0.9em;
                color: #666;
            }
            .summary {
                white-space: pre-line;
            }
            .loading {
                text-align: center;
                padding: 20px;
                color: #666;
            }
            button {
                padding: 10px 20px;
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                font-size: 1em;
                transition: background-color 0.3s;
            }
            button:hover {
                background-color: #2980b9;
            }
            button:disabled {
                background-color: #bdc3c7;
                cursor: not-allowed;
            }
            ul {
                margin: 0;
                padding-left: 20px;
            }
            li {
                margin-bottom: 8px;
            }
            h1 {
                color: #2c3e50;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <h1>Primary Inbox - Unread Email Summaries</h1>
        <button id="startButton" onclick="startSummarization()">Generate Summaries</button>
        <div id="loading" class="loading" style="display: none;">
            Generating summaries of unread primary inbox emails... This may take a few minutes.
        </div>
        <div id="summaries"></div>

        <script>
            async function startSummarization() {
                const button = document.getElementById('startButton');
                const loading = document.getElementById('loading');
                const summariesDiv = document.getElementById('summaries');
                
                button.disabled = true;
                loading.style.display = 'block';
                summariesDiv.innerHTML = '';

                try {
                    const response = await fetch('/api/start-summary', { method: 'POST' });
                    const data = await response.json();
                    
                    if (data.success) {
                        await loadSummaries();
                    } else {
                        throw new Error(data.error || 'Failed to generate summaries');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error generating summaries: ' + error.message);
                } finally {
                    button.disabled = false;
                    loading.style.display = 'none';
                }
            }

            async function loadSummaries() {
                const summariesDiv = document.getElementById('summaries');
                
                try {
                    const response = await fetch('/api/summaries');
                    const summaries = await response.json();
                    
                    if (summaries.length === 0) {
                        summariesDiv.innerHTML = '<p>No unread emails found in primary inbox.</p>';
                        return;
                    }
                    
                    summariesDiv.innerHTML = summaries.map(summary => \`
                        <div class="summary-card">
                            <div class="email-header">
                                <div class="subject">\${summary.subject}</div>
                                <div class="meta-info">
                                    From: \${summary.from}<br>
                                    Date: \${summary.date}
                                </div>
                            </div>
                            <div class="summary">\${summary.summary}</div>
                        </div>
                    \`).join('');
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error loading summaries: ' + error.message);
                }
            }

            // Load any existing summaries when the page loads
            loadSummaries();
        </script>
    </body>
    </html>
  `);
});

// API endpoints
app.get('/api/summaries', (req, res) => {
  res.json(summaries);
});

app.post('/api/start-summary', async (req, res) => {
  try {
    console.log('Starting summary generation for primary inbox...');
    summaries.length = 0; // Clear existing summaries
    const auth = await authorize();
    const messages = await listPrimaryInboxMessages(auth);

    if (!messages.length) {
      return res.json({ success: true, message: 'No unread emails found in primary inbox' });
    }

    for (const message of messages) {
      console.log(`Processing message ID: ${message.id}`);
      const fullMessage = await getMessage(auth, message.id);
      const emailBody = getEmailBody(fullMessage.payload);
      const summary = await summarizeEmail(emailBody);
      const details = getEmailDetails(fullMessage);
      
      summaries.push({ 
        id: message.id,
        ...details,
        summary 
      });
      
      console.log(`Processed email with subject: ${details.subject}`);
    }
    res.json({ success: true, message: 'Summaries generated successfully' });
  } catch (error) {
    console.error('Error in /api/start-summary:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Visit http://localhost:${port} in your browser to use the application`);
});