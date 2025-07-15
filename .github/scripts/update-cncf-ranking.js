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
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000); // 30秒のタイムアウト

    console.log("Navigating to DevStats...");
    await page.goto(DEVSTATS_URL, { waitUntil: "networkidle" });

    // テーブルが表示されるまで待つ
    console.log("Waiting for table to load...");
    await page.waitForSelector('[role="table"]', { timeout: 30000 });

    // データが完全に読み込まれるまで少し待つ
    await page.waitForTimeout(5000);

    console.log(`Searching for ${SEARCH_NAME}...`);

    // テーブルから順位を検索
    const ranking = await page.evaluate((searchName) => {
      // すべての行を取得
      const rows = document.querySelectorAll('[role="row"]');

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // 行内のすべてのセルを取得
        const cells = row.querySelectorAll('[role="cell"]');

        if (cells.length >= 2) {
          // 2番目のセル（GitHubログイン名）をチェック
          const nameCell = cells[1];
          const nameText = nameCell?.textContent?.trim();

          if (nameText === searchName) {
            // 最初のセル（順位）を取得
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

      // デバッグ用：スクリーンショットを保存
      await page.screenshot({ path: "devstats-debug.png", fullPage: true });
      console.log("Debug screenshot saved as devstats-debug.png");
    }

    return ranking;
  } finally {
    await browser.close();
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
