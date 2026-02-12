#!/usr/bin/env python3
"""
GitHub Contribution Projects Updater

This script automatically detects projects that a user has contributed to
and updates the specified section in the README file.
"""

import os
import re
import requests
import json
import sys
from typing import List, Dict, Tuple
from datetime import datetime, timedelta, timezone

class GitHubContribUpdater:
    def __init__(self, username: str, token: str):
        self.username = username
        self.token = token
        self.headers = {
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        self.graphql_headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }

    def get_user_contributions(self) -> List[Dict]:
        """Fetch user contribution data"""
        print(f"Fetching contributions for {self.username}...")

        # Fetch contribution data using GraphQL query
        query = """
        query($username: String!) {
          user(login: $username) {
            pullRequests(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                repository {
                  name
                  owner {
                    login
                  }
                  stargazerCount
                  isArchived
                  isFork
                }
                state
                merged
                createdAt
              }
            }
            issues(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                repository {
                  name
                  owner {
                    login
                  }
                  stargazerCount
                  isArchived
                  isFork
                }
                state
                createdAt
              }
            }
          }
        }
        """

        variables = {
            "username": self.username
        }

        response = requests.post(
            'https://api.github.com/graphql',
            headers=self.graphql_headers,
            json={'query': query, 'variables': variables}
        )

        if response.status_code != 200:
            error_msg = f"GitHub API request failed with status {response.status_code}: {response.text}"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)

        data = response.json()
        if 'errors' in data:
            error_msg = f"GraphQL errors: {data['errors']}"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)

        user_data = data.get('data', {}).get('user', {})
        if not user_data:
            error_msg = "No user data found in GitHub API response"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)

        print(f"Found {len(user_data.get('pullRequests', {}).get('nodes', []))} PRs")
        print(f"Found {len(user_data.get('issues', {}).get('nodes', []))} issues")

        return user_data

    def calculate_project_scores(self, contributions: Dict) -> List[Tuple[str, str, float]]:
        """Calculate project scores"""
        project_scores = {}

        # Date filter for the past year (UTC)
        one_year_ago = datetime.now(timezone.utc) - timedelta(days=365)

        # Process Pull Requests
        for pr in contributions.get('pullRequests', {}).get('nodes', []):
            # Date filtering
            created_at = datetime.fromisoformat(pr['createdAt'].replace('Z', '+00:00'))
            if created_at < one_year_ago:
                continue

            repo = pr['repository']
            if not repo or repo['owner']['login'] == self.username:
                continue  # Exclude own repositories

            if repo['isArchived'] or repo['isFork']:
                continue  # Exclude archived or forked repositories

            repo_key = f"{repo['owner']['login']}/{repo['name']}"

            if repo_key not in project_scores:
                project_scores[repo_key] = {
                    'owner': repo['owner']['login'],
                    'name': repo['name'],
                    'stars': repo['stargazerCount'],
                    'pr_count': 0,
                    'merged_pr_count': 0,
                    'issue_count': 0
                }

            project_scores[repo_key]['pr_count'] += 1
            if pr['merged']:
                project_scores[repo_key]['merged_pr_count'] += 1

        # Process Issues
        for issue in contributions.get('issues', {}).get('nodes', []):
            # Date filtering
            created_at = datetime.fromisoformat(issue['createdAt'].replace('Z', '+00:00'))
            if created_at < one_year_ago:
                continue

            repo = issue['repository']
            if not repo or repo['owner']['login'] == self.username:
                continue

            if repo['isArchived'] or repo['isFork']:
                continue

            repo_key = f"{repo['owner']['login']}/{repo['name']}"

            if repo_key not in project_scores:
                project_scores[repo_key] = {
                    'owner': repo['owner']['login'],
                    'name': repo['name'],
                    'stars': repo['stargazerCount'],
                    'pr_count': 0,
                    'merged_pr_count': 0,
                    'issue_count': 0
                }

            project_scores[repo_key]['issue_count'] += 1

        # Score calculation (evaluate only own contributions)
        scored_projects = []
        for repo_key, data in project_scores.items():
            # Calculate score based only on own contributions
            contribution_score = (
                data['pr_count'] * 10 +           # PR creation: 10 points
                data['merged_pr_count'] * 15 +    # Merged PR: 15 points (bonus)
                data['issue_count'] * 5           # Issue creation: 5 points
            )

            # Lightly factor in star count as reference (minimize impact)
            popularity_bonus = min(data['stars'] * 0.001, 5)  # Maximum 5 points

            total_score = contribution_score + popularity_bonus

            # Minimum contribution score threshold (only when actual contributions exist)
            if contribution_score >= 10:  # At least 1 PR or 2+ issues
                scored_projects.append((data['owner'], data['name'], total_score))
                print(f"  {data['owner']}/{data['name']}: PR={data['pr_count']}, Merged={data['merged_pr_count']}, Issues={data['issue_count']}, Score={total_score:.1f}")

        # Sort by score
        scored_projects.sort(key=lambda x: x[2], reverse=True)
        return scored_projects[:16]  # Top 16 projects

    def generate_project_cards(self, projects: List[Tuple[str, str, float]]) -> str:
        """Generate HTML for project cards"""
        if not projects:
            return "<!-- No significant contributions found -->"

        cards_html = []
        for i, (owner, repo, score) in enumerate(projects):
            # Create pairs for 2-column layout
            if i % 2 == 0:
                cards_html.append('<div align="center">')

            card_html = f'''<a href="https://github.com/{owner}/{repo}">
  <img align="center" src="https://readme-stats-fast.vercel.app/api/pin/?username={owner}&repo={repo}&theme=github_dark&hide_border=true" />
</a>'''

            cards_html.append(card_html)

            # Close div for second card or last card
            if i % 2 == 1 or i == len(projects) - 1:
                cards_html.append('</div>')
                if i < len(projects) - 1:  # Add line break if not the last
                    cards_html.append('')

        return '\n'.join(cards_html)

    def update_readme(self, project_cards: str) -> bool:
        """Update README file"""
        readme_path = 'README.md'

        try:
            with open(readme_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except FileNotFoundError:
            error_msg = f"README.md not found at {readme_path}"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"Failed to read README.md: {e}"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)

        # Find and replace placeholders
        start_marker = '<!-- CONTRIB-PROJECTS:START -->'
        end_marker = '<!-- CONTRIB-PROJECTS:END -->'

        pattern = f'{re.escape(start_marker)}.*?{re.escape(end_marker)}'
        replacement = f'{start_marker}\n{project_cards}\n{end_marker}'

        new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)

        if new_content == content:
            print("No changes needed in README.md")
            return False

        # Check if placeholders are not found
        if start_marker not in content or end_marker not in content:
            error_msg = f"Required placeholders ({start_marker} and {end_marker}) not found in README.md"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)

        try:
            with open(readme_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
        except Exception as e:
            error_msg = f"Failed to write README.md: {e}"
            print(f"Error: {error_msg}")
            raise Exception(error_msg)

        print("README.md updated successfully")
        return True

def main():
    try:
        username = os.getenv('USERNAME')
        token = os.getenv('GITHUB_TOKEN')

        if not username or not token:
            print("Error: USERNAME and GITHUB_TOKEN environment variables are required")
            sys.exit(1)

        print(f"Starting contribution analysis for user: {username}")

        updater = GitHubContribUpdater(username, token)

        # Fetch contribution data
        contributions = updater.get_user_contributions()
        if not contributions:
            print("Error: Failed to fetch contribution data")
            sys.exit(1)

        # Calculate project scores
        top_projects = updater.calculate_project_scores(contributions)
        print(f"\nFound {len(top_projects)} significant contribution projects:")

        if top_projects:
            print("\nTop projects by contribution score:")
            for i, (owner, repo, score) in enumerate(top_projects, 1):
                print(f"  {i}. {owner}/{repo} (total score: {score:.1f})")

            # Generate project cards
            project_cards = updater.generate_project_cards(top_projects)

            # Update README
            if updater.update_readme(project_cards):
                print("Successfully updated README.md")
            else:
                print("README.md was not updated (no changes needed)")
        else:
            print("No projects meet the minimum score threshold")
            # Update with empty placeholder
            empty_cards = "<!-- No significant contributions found -->"
            if not updater.update_readme(empty_cards):
                print("Warning: Failed to update README.md with empty placeholder")

        print("Script completed successfully")

    except Exception as e:
        print(f"Error: Script failed with exception: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
