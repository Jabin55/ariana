"""setup.sh 를 그대로 품은 cloud-init 파일을 만든다: python deploy/livekit/make_cloud_init.py

Hetzner 등에서 서버를 만들 때 'Cloud config' 칸에 cloud-init.yaml 내용을 붙여 넣으면
서버가 처음 켜질 때 설치가 자동으로 끝난다.
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent


def build() -> str:
    script = (HERE / "setup.sh").read_text(encoding="utf-8")
    body = "".join(f"      {line}\n" if line else "\n" for line in script.splitlines())
    return (
        "#cloud-config\n"
        "# 실시간 수업 화상 서버 자동 설치 (deploy/livekit/setup.sh 를 그대로 담고 있음)\n"
        "# 내 도메인을 쓰려면 맨 아래 줄 끝에 도메인을 적으세요. 예: bash /root/setup.sh live.myschool.kr\n"
        "write_files:\n"
        "  - path: /root/setup.sh\n"
        '    permissions: "0755"\n'
        "    content: |\n"
        f"{body}"
        "runcmd:\n"
        "  - bash /root/setup.sh > /root/setup.log 2>&1\n"
    )


if __name__ == "__main__":
    (HERE / "cloud-init.yaml").write_text(build(), encoding="utf-8")
    print("cloud-init.yaml 을 만들었습니다.")
