import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import { join } from 'path';

// DevStats URL
const DEVSTATS_URL = 'https://all.devstats.cncf.io/d/66/developer-activity-counts-by-companies?orgId=1&var-period_name=Last%20year&var-country_name=Japan&var-repogroup_name=All&var-metric=contributions&var-companies=All';

// 検索対象の名前（環境変数から取得可能）
const SEARCH_NAME = process.env.GITHUB_ACTOR || 'kahirokunn';

async function scrapeRanking() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  // 動画は常に録画し、成功時は削除・エラー時は保持する
  const context = await browser.newContext({
    recordVideo: { dir: "videos", size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000); // 60秒に延長（CIでの遅延対策）

  let shouldKeepVideo = false;
  try {
    console.log("Navigating to DevStats...");
    await page.goto(DEVSTATS_URL, { waitUntil: "networkidle" });

    // たまに表示が遅いので追加待機
    console.log("Waiting for table to load...");
    await Promise.race([
      page.waitForSelector('[role="table"]', { timeout: 60000 }),
      page.waitForSelector("table", { timeout: 60000 }),
    ]);

    // データが完全に読み込まれるまで少し待つ
    await page.waitForTimeout(6000);

    console.log(`Searching for ${SEARCH_NAME}...`);

    // テーブルから順位を検索
    const ranking = await page.evaluate((searchName) => {
      const byRoleRows = Array.from(document.querySelectorAll('[role="row"]'));
      const byTableRows = Array.from(document.querySelectorAll("table tr"));
      const rows = byRoleRows.length > 0 ? byRoleRows : byTableRows;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        const cellsByRole = row.querySelectorAll('[role="cell"]');
        const cellsByTd = row.querySelectorAll("td");
        const cells = cellsByRole.length > 0 ? cellsByRole : cellsByTd;

        if (cells.length >= 2) {
          const nameCell = cells[1];
          const nameText = nameCell?.textContent?.trim();

          if (nameText === searchName) {
            const rankCell = cells[0];
            const rankText = rankCell?.textContent?.trim();

            if (rankText && /^\d+$/.test(rankText)) {
              return parseInt(rankText);
            }
          }
        }
      }

      return null;
    }, SEARCH_NAME);

    if (ranking) {
      console.log(`Found ranking: #${ranking}`);
    } else {
      console.log("Ranking not found");
      await page.screenshot({ path: "devstats-debug.png", fullPage: true });
      await fs.writeFile("devstats-debug.html", await page.content());
      console.log(
        "Saved debug artifacts: devstats-debug.png, devstats-debug.html"
      );
      shouldKeepVideo = true;
    }

    return ranking;
  } catch (error) {
    shouldKeepVideo = true;
    // 失敗時は必ずアーティファクトを残す
    try {
      await page.screenshot({ path: "devstats-debug.png", fullPage: true });
      await fs.writeFile("devstats-debug.html", await page.content());
      console.log(
        "Saved debug artifacts on error: devstats-debug.png, devstats-debug.html"
      );
    } catch (e) {
      console.warn("Failed to save debug artifacts:", e);
    }
    throw error;
  } finally {
    await context.close();
    await browser.close();

    // 成功時は動画を削除、失敗や未取得時は保持
    if (!shouldKeepVideo) {
      try {
        await fs.rm("videos", { recursive: true, force: true });
      } catch {}
    }
  }
}

async function updateReadme(ranking) {
  if (!ranking) {
    console.error("Ranking not found");
    return false;
  }

  const readmePath = join(process.cwd(), "README.md");
  let content = await fs.readFile(readmePath, "utf8");

  // CNCF_RANKING_START と CNCF_RANKING_END の間のコンテンツを更新
  const startMarker = "<!-- CNCF_RANKING_START -->";
  const endMarker = "<!-- CNCF_RANKING_END -->";

  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    console.error("Ranking markers not found in README");
    return false;
  }

  const ordinalSuffix = getOrdinalSuffix(ranking);
  const currentDate = new Date().toISOString().slice(0, 7); // YYYY-MM format

  const newContent = `<!-- CNCF_RANKING_START -->
**[#${ranking} Top CNCF Contributor in Japan](${DEVSTATS_URL})** (Last Year)
*Ranked ${ranking}${ordinalSuffix} among all developers in Japan contributing to CNCF projects*
<!-- CNCF_RANKING_END -->

<!--
Note: This ranking is updated periodically.
Future automation: Planning to implement automatic updates using GitHub Actions.
Last checked: ${currentDate}
-->

<a href="${DEVSTATS_URL}">
  <img src="https://img.shields.io/badge/CNCF%20Japan-Top%20${ranking}-brightgreen?style=for-the-badge&logo=cncf" alt="CNCF Top ${ranking} Japan"/>
</a>`;

  const beforeContent = content.substring(0, startIndex);
  const afterContent = content.substring(endIndex + endMarker.length);

  // 既存のバッジ部分と重複するコメント部分を削除
  const badgePattern =
    /<a href="[^"]*devstats\.cncf\.io[^"]*">\s*<img src="[^"]*CNCF[^"]*" alt="[^"]*"\/>\s*<\/a>/g;
  const commentPattern =
    /<!--\s*Note: This ranking is updated periodically\.[\s\S]*?-->/g;

  let cleanedAfterContent = afterContent.replace(badgePattern, "");
  cleanedAfterContent = cleanedAfterContent.replace(commentPattern, "");

  // 余分な空行を削除
  cleanedAfterContent = cleanedAfterContent.replace(/\n\n\n+/g, "\n\n");

  content = beforeContent + newContent + cleanedAfterContent;

  await fs.writeFile(readmePath, content);
  console.log("README updated successfully");
  return true;
}

function getOrdinalSuffix(num) {
  const j = num % 10;
  const k = num % 100;

  if (j === 1 && k !== 11) {
    return 'st';
  }
  if (j === 2 && k !== 12) {
    return 'nd';
  }
  if (j === 3 && k !== 13) {
    return 'rd';
  }
  return 'th';
}

// メイン実行
async function main() {
  try {
    console.log('Starting CNCF ranking update...');
    const ranking = await scrapeRanking();

    if (ranking) {
      await updateReadme(ranking);
      console.log(`Successfully updated ranking to #${ranking}`);

      // GitHub Actions用の出力
      if (process.env.GITHUB_OUTPUT) {
        await fs.appendFile(process.env.GITHUB_OUTPUT, `ranking=${ranking}\n`);
      }
    } else {
      console.error('Failed to find ranking');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
