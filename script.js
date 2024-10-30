function fetchSummaries() {
    fetch('/summaries')
      .then(response => response.json())
      .then(data => {
        const summariesDiv = document.getElementById('summaries');
        summariesDiv.innerHTML = '';
        data.forEach(summary => {
          const summaryElement = document.createElement('div');
          summaryElement.innerHTML = `
            <h3>Email ID: ${summary.id}</h3>
            <p>${summary.summary}</p>
            <hr>
          `;
          summariesDiv.appendChild(summaryElement);
        });
      })
      .catch(error => console.error('Error:', error));
  }
  
  fetchSummaries();