(async () => {
    try {
        const response = await fetch('https://ais-dev-ynmbt7hwly7nsrmtf6yx7s-483782890760.asia-southeast1.run.app/api/create-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'Test', email: 'test@example.com' })
        });
        const text = await response.text();
        console.log(`STATUS: ${response.status}`);
        console.log(`BODY: ${text}`);
    } catch (e) {
        console.error(e);
    }
})();
