import { promises as fs } from 'fs';
import * as path from 'path';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as git from './git';
import { Benchmark, BenchmarkResult } from './extract';
import { Config, ToolType } from './config';
import { DEFAULT_INDEX_HTML } from './default_index_html';

export type BenchmarkSuites = { [name: string]: Benchmark[] };
export interface DataJson {
    lastUpdate: number;
    repoUrl: string;
    entries: BenchmarkSuites;
}

export const SCRIPT_PREFIX = 'window.BENCHMARK_DATA = ';
const DEFAULT_DATA_JSON = {
    lastUpdate: 0,
    repoUrl: '',
    entries: {},
};

async function loadDataJs(dataPath: string): Promise<DataJson> {
    try {
        const script = await fs.readFile(dataPath, 'utf8');
        const json = script.slice(SCRIPT_PREFIX.length);
        const parsed = JSON.parse(json);
        core.debug(`Loaded data.js at ${dataPath}`);
        return parsed;
    } catch (err) {
        console.log(`Could not find data.js at ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_DATA_JSON };
    }
}

async function storeDataJs(dataPath: string, data: DataJson) {
    const script = SCRIPT_PREFIX + JSON.stringify(data, null, 2);
    await fs.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}

async function addIndexHtmlIfNeeded(dir: string) {
    const indexHtml = path.join(dir, 'index.html');
    try {
        await fs.stat(indexHtml);
        core.debug(`Skipped to create default index.html since it is already existing: ${indexHtml}`);
        return;
    } catch (_) {
        // Continue
    }

    await fs.writeFile(indexHtml, DEFAULT_INDEX_HTML, 'utf8');
    await git.cmd('add', indexHtml);
    console.log('Created default index.html at', indexHtml);
}

function biggerIsBetter(tool: ToolType): boolean {
    switch (tool) {
        case 'cargo':
            return false;
        case 'go':
            return false;
        case 'benchmarkjs':
            return true;
        case 'benchmarkluau':
            return false;
        case 'pytest':
            return true;
        case 'googlecpp':
            return false;
        case 'catch2':
            return false;
        case 'julia':
            return false;
        case 'benchmarkdotnet':
            return false;
        case 'customBiggerIsBetter':
            return true;
        case 'customSmallerIsBetter':
            return false;
    }
}

interface Alert {
    current: BenchmarkResult;
    prev: BenchmarkResult;
    ratio: number;
}

function findAlerts(
    curSuite: Benchmark,
    prevSuite: Benchmark,
    prevBest: { [key: string]: BenchmarkResult },
    threshold: number,
    compareWithBest: boolean,
): Alert[] {
    if (compareWithBest) {
        core.debug(`Comparing current:${curSuite.commit.id} and prev:${prevSuite.commit.id} for alert`);
    } else {
        core.debug(`Comparing current:${curSuite.commit.id} and best results for alert`);
    }

    const alerts = [];
    for (const current of curSuite.benches) {
        const prev = compareWithBest ? prevBest[current.name] : prevSuite.benches.find((b) => b.name === current.name);
        if (prev === undefined) {
            core.debug(`Skipped because benchmark '${current.name}' is not found in previous benchmarks`);
            continue;
        }

        const ratio = biggerIsBetter(curSuite.tool)
            ? prev.value / current.value // e.g. current=100, prev=200
            : current.value / prev.value; // e.g. current=200, prev=100

        if (ratio > threshold) {
            core.warning(
                `Performance alert! Previous value was ${prev.value} and current value is ${current.value}.` +
                    ` It is ${ratio}x worse than previous exceeding a ratio threshold ${threshold}`,
            );
            alerts.push({ current, prev, ratio });
        }
    }

    return alerts;
}

function getCurrentRepoMetadata() {
    const { repo, owner } = github.context.repo;
    const serverUrl = git.getServerUrl(github.context.payload.repository?.html_url);
    return {
        name: repo,
        owner: {
            login: owner,
        },
        // eslint-disable-next-line @typescript-eslint/naming-convention
        html_url: `${serverUrl}/${owner}/${repo}`,
    };
}

function floatStr(n: number) {
    if (Number.isInteger(n)) {
        return n.toFixed(0);
    }

    if (n > 0.1) {
        return n.toFixed(2);
    }

    return n.toString();
}

function strVal(b: BenchmarkResult | undefined): string {
    if (b === undefined) {
        return '';
    }
    let s = `\`${b.value}\` ${b.unit}`;
    if (b.range) {
        s += ` (\`${b.range}\`)`;
    }
    return s;
}

function commentFooter(config: Config): string {
    const { commentFooter } = config;

    const repoMetadata = getCurrentRepoMetadata();
    const repoUrl = repoMetadata.html_url ?? '';
    const actionUrl = repoUrl + '/actions?query=workflow%3A' + encodeURIComponent(github.context.workflow);

    let footer = `This comment was automatically generated by [workflow](${actionUrl}) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`;
    if (commentFooter) {
        footer = commentFooter + '\n\n' + footer;
    }
    return footer;
}

function buildComment(
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    prevBest: { [key: string]: BenchmarkResult },
    compareWithBest: boolean,
    config: Config,
): string {
    const ratioStr = compareWithBest ? 'Ratio vs. Best' : 'Ratio';
    const lines = [
        `# ${benchName}`,
        '',
        '<details>',
        '',
        `| Benchmark suite | Best | Previous: ${prevSuite.commit.id} | Current: ${curSuite.commit.id} | ${ratioStr} |`,
        '|-|-|-|-|-|',
    ];

    for (const current of curSuite.benches) {
        const best = prevBest[current.name];
        const prev = prevSuite.benches.find((i) => i.name === current.name);
        let line = `| \`${current.name}\` | ${strVal(best)} | ${strVal(prev)} | ${strVal(current)}`;

        const base = compareWithBest ? best : prev;
        if (base) {
            const ratio = biggerIsBetter(curSuite.tool)
                ? base.value / current.value // e.g. current=100, prev=200
                : current.value / base.value;
            line = line + ` | \`${floatStr(ratio)}\` |`;
        } else {
            line = line + ` | |`;
        }

        lines.push(line);
    }

    // Footer
    lines.push('', '</details>', '', commentFooter(config));

    return lines.join('\n');
}

function buildAlertComment(
    alerts: Alert[],
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    prevBest: { [key: string]: BenchmarkResult },
    threshold: number,
    compareWithBest: boolean,
    cc: string[],
    config: Config,
): string {
    // Do not show benchmark name if it is the default value 'Benchmark'.
    const benchmarkText = benchName === 'Benchmark' ? '' : ` **'${benchName}'**`;
    const title = threshold === 0 ? '# Performance Report' : '# :warning: **Performance Alert** :warning:';
    const thresholdString = floatStr(threshold);
    const ratioStr = compareWithBest ? 'Ratio vs. Best' : 'Ratio';
    const lines = [
        title,
        '',
        `Possible performance regression was detected for benchmark${benchmarkText}.`,
        `Benchmark result of this commit is worse than the previous benchmark result exceeding threshold \`${thresholdString}\`.`,
        '',
        `| Benchmark suite | Best | Previous: ${prevSuite.commit.id} | Current: ${curSuite.commit.id} | ${ratioStr} |`,
        '|-|-|-|-|-|',
    ];

    for (const alert of alerts) {
        const { current, ratio } = alert;
        const best = prevBest[current.name];
        const prev = prevSuite.benches.find((b) => b.name === current.name);
        const line =
            `| \`${current.name}\` | ${strVal(best)} | ${strVal(prev)} ` +
            `| ${strVal(current)} | \`${floatStr(ratio)}\` |`;
        lines.push(line);
    }

    // Footer
    lines.push('', commentFooter(config));

    if (cc.length > 0) {
        lines.push('', `CC: ${cc.join(' ')}`);
    }

    return lines.join('\n');
}

async function leaveComment(commitId: string, body: string, token: string) {
    core.debug('Sending comment:\n' + body);

    const repoMetadata = getCurrentRepoMetadata();
    const repoUrl = repoMetadata.html_url ?? '';
    const client = new github.GitHub(token);
    const res = await client.repos.createCommitComment({
        owner: repoMetadata.owner.login,
        repo: repoMetadata.name,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        commit_sha: commitId,
        body,
    });

    const commitUrl = `${repoUrl}/commit/${commitId}`;
    console.log(`Comment was sent to ${commitUrl}. Response:`, res.status, res.data);

    return res;
}

async function handleComment(
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    prevBest: { [key: string]: BenchmarkResult },
    config: Config,
) {
    const { commentAlways, githubToken, compareWithBest } = config;

    if (!commentAlways) {
        core.debug('Comment check was skipped because comment-always is disabled');
        return;
    }

    if (!githubToken) {
        throw new Error("'comment-always' input is set but 'github-token' input is not set");
    }

    core.debug('Commenting about benchmark comparison');

    const body = buildComment(benchName, curSuite, prevSuite, prevBest, compareWithBest, config);

    await leaveComment(curSuite.commit.id, body, githubToken);
}

async function handleAlert(
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    prevBest: { [key: string]: BenchmarkResult },
    config: Config,
) {
    const {
        alertThreshold,
        githubToken,
        commentOnAlert,
        failOnAlert,
        alertCommentCcUsers,
        failThreshold,
        compareWithBest,
    } = config;

    if (!commentOnAlert && !failOnAlert) {
        core.debug('Alert check was skipped because both comment-on-alert and fail-on-alert were disabled');
        return;
    }

    const alerts = findAlerts(curSuite, prevSuite, prevBest, alertThreshold, compareWithBest);
    if (alerts.length === 0) {
        core.debug('No performance alert found happily');
        return;
    }

    core.debug(`Found ${alerts.length} alerts`);
    const body = buildAlertComment(
        alerts,
        benchName,
        curSuite,
        prevSuite,
        prevBest,
        alertThreshold,
        compareWithBest,
        alertCommentCcUsers,
        config,
    );
    let message = body;
    let url = null;

    if (commentOnAlert) {
        if (!githubToken) {
            throw new Error("'comment-on-alert' input is set but 'github-token' input is not set");
        }
        const res = await leaveComment(curSuite.commit.id, body, githubToken);
        url = res.data.html_url;
        message = body + `\nComment was generated at ${url}`;
    }

    if (failOnAlert) {
        // Note: alertThreshold is smaller than failThreshold. It was checked in config.ts
        const len = alerts.length;
        const threshold = floatStr(failThreshold);
        const failures = alerts.filter((a) => a.ratio > failThreshold);
        if (failures.length > 0) {
            core.debug('Mark this workflow as fail since one or more fatal alerts found');
            if (failThreshold !== alertThreshold) {
                // Prepend message that explains how these alerts were detected with different thresholds
                message = `${failures.length} of ${len} alerts exceeded the failure threshold \`${threshold}\` specified by fail-threshold input:\n\n${message}`;
            }
            throw new Error(message);
        } else {
            core.debug(
                `${len} alerts exceeding the alert threshold ${alertThreshold} were found but` +
                    ` all of them did not exceed the failure threshold ${threshold}`,
            );
        }
    }
}

function addBenchmarkToDataJson(
    benchName: string,
    bench: Benchmark,
    data: DataJson,
    maxItems: number | null,
): Benchmark[] {
    const repoMetadata = getCurrentRepoMetadata();
    const htmlUrl = repoMetadata.html_url ?? '';

    data.lastUpdate = Date.now();
    data.repoUrl = htmlUrl;

    // Add benchmark result
    if (data.entries[benchName] === undefined) {
        data.entries[benchName] = [bench];
        core.debug(`No suite was found for benchmark '${benchName}' in existing data. Created`);
        return [];
    } else {
        const suites = data.entries[benchName];
        const prevSuites = suites.filter((e) => e.commit.id !== bench.commit.id);
        suites.push(bench);

        if (maxItems !== null && suites.length > maxItems) {
            suites.splice(0, suites.length - maxItems);
            core.debug(
                `Number of data items for '${benchName}' was truncated to ${maxItems} due to max-items-in-charts`,
            );
        }
        return prevSuites;
    }
}

function isRemoteRejectedError(err: unknown) {
    if (err instanceof Error) {
        return ['[remote rejected]', '[rejected]'].some((l) => err.message.includes(l));
    }
    return false;
}

async function writeBenchmarkToGitHubPagesWithRetry(
    bench: Benchmark,
    config: Config,
    retry: number,
): Promise<Benchmark[]> {
    const {
        name,
        tool,
        ghPagesBranch,
        benchmarkDataDirPath,
        githubToken,
        autoPush,
        skipFetchGhPages,
        maxItemsInChart,
    } = config;
    const dataPath = path.join(benchmarkDataDirPath, 'data.js');
    // FIXME: This payload is not available on `schedule:` or `workflow_dispatch:` events.
    const isPrivateRepo = github.context.payload.repository?.private ?? false;

    if (!skipFetchGhPages && (!isPrivateRepo || githubToken)) {
        await git.pull(githubToken, ghPagesBranch);
    } else if (isPrivateRepo && !skipFetchGhPages) {
        core.warning(
            "'git pull' was skipped. If you want to ensure GitHub Pages branch is up-to-date " +
                "before generating a commit, please set 'github-token' input to pull GitHub pages branch",
        );
    }

    await io.mkdirP(benchmarkDataDirPath);

    const data = await loadDataJs(dataPath);
    const prevSuites = addBenchmarkToDataJson(name, bench, data, maxItemsInChart);

    await storeDataJs(dataPath, data);

    await git.cmd('add', dataPath);
    await addIndexHtmlIfNeeded(benchmarkDataDirPath);
    await git.cmd('commit', '-m', `add ${name} (${tool}) benchmark result for ${bench.commit.id}`);

    if (githubToken && autoPush) {
        try {
            await git.push(githubToken, ghPagesBranch);
            console.log(
                `Automatically pushed the generated commit to ${ghPagesBranch} branch since 'auto-push' is set to true`,
            );
        } catch (err: any) {
            if (!isRemoteRejectedError(err)) {
                throw err;
            }
            // Fall through

            core.warning(`Auto-push failed because the remote ${ghPagesBranch} was updated after git pull`);

            if (retry > 0) {
                core.debug('Rollback the auto-generated commit before retry');
                await git.cmd('reset', '--hard', 'HEAD~1');

                core.warning(
                    `Retrying to generate a commit and push to remote ${ghPagesBranch} with retry count ${retry}...`,
                );
                return await writeBenchmarkToGitHubPagesWithRetry(bench, config, retry - 1); // Recursively retry
            } else {
                core.warning(`Failed to add benchmark data to '${name}' data: ${JSON.stringify(bench)}`);
                throw new Error(
                    `Auto-push failed 3 times since the remote branch ${ghPagesBranch} rejected pushing all the time. Last exception was: ${err.message}`,
                );
            }
        }
    } else {
        core.debug(
            `Auto-push to ${ghPagesBranch} is skipped because it requires both 'github-token' and 'auto-push' inputs`,
        );
    }

    return prevSuites;
}

async function writeBenchmarkToGitHubPages(bench: Benchmark, config: Config): Promise<Benchmark[]> {
    const { ghPagesBranch, skipFetchGhPages, githubToken } = config;
    if (!skipFetchGhPages) {
        await git.fetch(githubToken, ghPagesBranch);
    }
    await git.cmd('switch', ghPagesBranch);
    try {
        return await writeBenchmarkToGitHubPagesWithRetry(bench, config, 10);
    } finally {
        // `git switch` does not work for backing to detached head
        await git.cmd('checkout', '-');
    }
}

async function loadDataJson(jsonPath: string): Promise<DataJson> {
    try {
        const content = await fs.readFile(jsonPath, 'utf8');
        const json: DataJson = JSON.parse(content);
        core.debug(`Loaded external JSON file at ${jsonPath}`);
        return json;
    } catch (err) {
        core.warning(
            `Could not find external JSON file for benchmark data at ${jsonPath}. Using empty default: ${err}`,
        );
        return { ...DEFAULT_DATA_JSON };
    }
}

async function writeBenchmarkToExternalJson(
    bench: Benchmark,
    jsonFilePath: string,
    config: Config,
): Promise<Benchmark[]> {
    const { name, maxItemsInChart, saveDataFile } = config;
    const data = await loadDataJson(jsonFilePath);
    const prevSuites = addBenchmarkToDataJson(name, bench, data, maxItemsInChart);

    if (!saveDataFile) {
        core.debug('Skipping storing benchmarks in external data file');
        return prevSuites;
    }

    try {
        const jsonDirPath = path.dirname(jsonFilePath);
        await io.mkdirP(jsonDirPath);
        await fs.writeFile(jsonFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        throw new Error(`Could not store benchmark data as JSON at ${jsonFilePath}: ${err}`);
    }

    return prevSuites;
}

export async function writeBenchmark(bench: Benchmark, config: Config) {
    const { name, externalDataJsonPath } = config;
    const prevSuites = externalDataJsonPath
        ? await writeBenchmarkToExternalJson(bench, externalDataJsonPath, config)
        : await writeBenchmarkToGitHubPages(bench, config);

    // Get last suite which has different commit ID for alert comment
    const prevBench: Benchmark | undefined = prevSuites[prevSuites.length - 1];

    // Get best benchmark (possibly including the current one)
    const better = biggerIsBetter(config.tool) ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
    const prevBest: { [key: string]: BenchmarkResult } = {};
    for (const b of bench.benches) {
        const results = prevSuites
            .map((e) => e.benches.find((i) => i.name === b.name))
            .filter((i) => i !== undefined) as BenchmarkResult[];
        if (results.length > 0) {
            prevBest[b.name] = results.reduce((best, curr) => (better(curr.value, best.value) ? curr : best));
        }
    }

    // Put this after `git push` for reducing possibility to get conflict on push. Since sending
    // comment take time due to API call, do it after updating remote branch.
    if (prevBench === undefined) {
        core.debug('Alert check was skipped because previous benchmark result was not found');
    } else {
        await handleComment(name, bench, prevBench, prevBest, config);
        await handleAlert(name, bench, prevBench, prevBest, config);
    }
}
