import axios from "axios";
import { reportSecret, reportAppId } from './config.js';


async function fetchReportData(table = "blacklist", type, referenceId) {
    try {
        const response = await axios.put("https://api.openreport.dev/report/get-entry", {
            appId: reportAppId,
            table: table,
            type,
            secret: reportSecret,
            referenceId
        }, { timeout: 1000 }); // 1 second timeout

        return response.data?.entry
            ? { listed: true, entry: response.data.entry }
            : { listed: false };
    } catch (error) {
        console.log('Timeout or error fetching report data:', error.message);
        return { listed: false };
    }
}

export { fetchReportData };