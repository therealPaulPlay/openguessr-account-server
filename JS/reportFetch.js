import { reportSecret, reportAppId } from './config.js';

export async function fetchReportData(table = "blacklist", type, referenceId) {
    try {
        const response = await fetch("https://openreport-api.paulplay.studio/report/get-entry", {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appId: reportAppId,
                table: table,
                type,
                secret: reportSecret,
                referenceId
            }),
            signal: AbortSignal.timeout(1000) // 1 second timeout
        });

        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const data = await response.json();
        return data?.entry
            ? { listed: true, entry: data.entry }
            : { listed: false };
    } catch (error) {
        console.log('Timeout or error fetching report data:', error.message);
        return { listed: false };
    }
}