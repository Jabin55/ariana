"""setup.sh 를 그대로 품은 cloud-init 파일을 만든다: python deploy/server/make_cloud_init.py

Hetzner 등에서 서버를 만들 때 'Cloud config' 칸에 cloud-init.yaml 내용을 붙여 넣으면
서버가 처음 켜질 때 수업 사이트·화상 서버·데이터베이스 설치가 자동으로 끝난다.
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent

SETTINGS = """\
# ▼ 붙여 넣기 전에 아래 두 줄을 채우세요 (나중에 콘솔에서 live-config 로 바꿀 수도 있어요)
# 전체 관리자 구글 이메일 (거점학교 관리교사 신청을 승인하는 사람, 쉼표로 여러 개)
ADMIN_EMAILS=
# 학생 구글 계정 도메인 (예: s.myschool.kr, 쉼표로 여러 개). 비우면 아무 구글 계정이나 학생이 됨
ALLOWED_DOMAINS=
"""


def indent(text: str) -> str:
    return "".join(f"      {line}\n" if line else "\n" for line in text.splitlines())


def build() -> str:
    script = (HERE / "setup.sh").read_text(encoding="utf-8")
    return (
        "#cloud-config\n"
        "# 실시간 수업 서버 자동 설치: 수업 사이트 + 화상 서버 + 데이터베이스 (deploy/server/setup.sh 를 그대로 담고 있음)\n"
        "# 내 도메인을 쓰려면 맨 아래 줄 끝에 도메인을 적으세요. 예: bash /root/setup.sh class.myschool.kr\n"
        "write_files:\n"
        "  - path: /root/live-settings.env\n"
        '    permissions: "0600"\n'
        "    content: |\n"
        f"{indent(SETTINGS)}"
        "  - path: /root/setup.sh\n"
        '    permissions: "0755"\n'
        "    content: |\n"
        f"{indent(script)}"
        "runcmd:\n"
        "  - bash /root/setup.sh > /root/setup.log 2>&1\n"
    )


if __name__ == "__main__":
    (HERE / "cloud-init.yaml").write_text(build(), encoding="utf-8")
    print("cloud-init.yaml 을 만들었습니다.")
