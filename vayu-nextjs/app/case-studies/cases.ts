export interface Line {
  t: string;
  mark?: "hot" | "add";
}

export interface CaseStudy {
  id: string;
  cwe: string;
  severity: "HIGH" | "CRITICAL" | "MEDIUM";
  title: string;
  file: string;
  impact: string;
  realWorld: string;
  whySubtle: string;
  vulnerable: Line[];
  patched: Line[];
  flagged: string;
}

/**
 * Five remediation case studies. Each vulnerable snippet is realistic code that
 * passes a casual review; the patch is the minimal correct fix VAYU verifies.
 */
export const CASES: CaseStudy[] = [
  {
    id: "tarfile",
    cwe: "CWE-22 · CVE-2007-4559",
    severity: "HIGH",
    title: "Path traversal in archive extraction",
    file: "plugins/installer.py",
    impact:
      "A crafted archive member named ../../../etc/cron.d/x escapes the destination and writes anywhere the process can — overwriting authorized_keys or dropping a cron job.",
    realWorld:
      "A 15-year-old flaw in Python's own standard library. When re-disclosed in 2022 it was found live in over 350,000 repositories, including build and CI tooling.",
    whySubtle:
      "It's a one-line convenience call — and extractall() is exactly what the Python docs themselves demonstrated for years. The danger is entirely in data you cannot see on the line: the archive's member names.",
    flagged: "tarfile.extractall() trusts attacker-controlled member paths",
    vulnerable: [
      { t: "import tarfile" },
      { t: "" },
      { t: "def unpack_plugin(archive_path: str, dest_dir: str) -> None:" },
      { t: '    """Install a plugin bundle uploaded by a tenant."""' },
      { t: "    with tarfile.open(archive_path) as tar:" },
      { t: "        tar.extractall(dest_dir)", mark: "hot" },
    ],
    patched: [
      { t: "import os" },
      { t: "import tarfile" },
      { t: "" },
      { t: "def unpack_plugin(archive_path: str, dest_dir: str) -> None:" },
      { t: '    """Install a plugin bundle uploaded by a tenant."""' },
      { t: "    dest = os.path.realpath(dest_dir)", mark: "add" },
      { t: "    with tarfile.open(archive_path) as tar:" },
      { t: "        for member in tar.getmembers():", mark: "add" },
      { t: "            resolved = os.path.realpath(os.path.join(dest, member.name))", mark: "add" },
      { t: "            if resolved != dest and not resolved.startswith(dest + os.sep):", mark: "add" },
      { t: "                raise ValueError(f'Path traversal blocked: {member.name!r}')", mark: "add" },
      { t: "        tar.extractall(dest)  # Python 3.12+: filter='data'", mark: "add" },
    ],
  },
  {
    id: "yaml",
    cwe: "CWE-502",
    severity: "CRITICAL",
    title: "Remote code execution via unsafe YAML load",
    file: "config/loader.py",
    impact:
      "The full loader instantiates arbitrary Python objects, so a tag like !!python/object/apply:os.system runs code the moment the config is parsed — before a single line of your logic executes.",
    realWorld:
      "The same deserialization class behind multiple Ansible and Salt RCE advisories. yaml.load is the single most common Python deserialization footgun in production config pipelines.",
    whySubtle:
      "The line reads as 'parse this config.' Nothing on it hints that a YAML document is a code-execution surface, and config files are routinely attacker-influenced — CI inputs, uploads, multi-tenant repos.",
    flagged: "yaml.load with a full Loader deserializes arbitrary objects",
    vulnerable: [
      { t: "import yaml" },
      { t: "" },
      { t: "def load_playbook(raw: str) -> dict:" },
      { t: '    """Parse a CI playbook fetched from the repo under test."""' },
      { t: "    return yaml.load(raw, Loader=yaml.Loader)", mark: "hot" },
    ],
    patched: [
      { t: "import yaml" },
      { t: "" },
      { t: "def load_playbook(raw: str) -> dict:" },
      { t: '    """Parse a CI playbook fetched from the repo under test."""' },
      { t: "    return yaml.safe_load(raw)  # plain data only; object tags rejected", mark: "add" },
    ],
  },
  {
    id: "timing",
    cwe: "CWE-208",
    severity: "HIGH",
    title: "Auth bypass via timing side channel",
    file: "api/webhooks.py",
    impact:
      "== short-circuits on the first differing byte, so response time leaks how many leading bytes are correct. Over many requests an attacker recovers the whole signature byte by byte — remotely.",
    realWorld:
      "The side channel that forced constant-time comparison into Django, Rails and the HMAC checks in OpenSSL. Keyczar's 2009 break is the textbook case.",
    whySubtle:
      "== is correct, passes every unit test, and is invisible to most scanners. The bug isn't in the logic — it's in how long the logic takes to run.",
    flagged: "Secret compared with ==, leaking length of correct prefix",
    vulnerable: [
      { t: "def verify_webhook(signature: str, expected: str) -> bool:" },
      { t: '    """Authenticate an inbound webhook before acting on it."""' },
      { t: "    return signature == expected", mark: "hot" },
    ],
    patched: [
      { t: "import hmac" },
      { t: "" },
      { t: "def verify_webhook(signature: str, expected: str) -> bool:" },
      { t: '    """Authenticate an inbound webhook before acting on it."""' },
      { t: "    return hmac.compare_digest(signature, expected)  # constant-time", mark: "add" },
    ],
  },
  {
    id: "xxe",
    cwe: "CWE-611",
    severity: "HIGH",
    title: "XML external entity — file read & SSRF",
    file: "sso/saml.py",
    impact:
      "With entities and DTDs resolved, a <!ENTITY xxe SYSTEM 'file:///etc/passwd'> reads local files, and a URL entity hits http://169.254.169.254 to steal cloud-metadata credentials.",
    realWorld:
      "The primitive behind real SAML single-sign-on bypasses and cloud-metadata SSRF. XXE has lived in the OWASP Top 10 for a decade precisely because the parser flags look harmless.",
    whySubtle:
      "The parser is doing exactly what it was told to. The vulnerability is three individually-plausible flags that together open local file reads and server-side request forgery.",
    flagged: "XMLParser resolves external entities and loads DTDs over the network",
    vulnerable: [
      { t: "from lxml import etree" },
      { t: "" },
      { t: "def parse_saml_assertion(xml: bytes):" },
      { t: '    """Parse a SAML assertion from an identity provider."""' },
      { t: "    parser = etree.XMLParser(resolve_entities=True, load_dtd=True,", mark: "hot" },
      { t: "                             no_network=False)", mark: "hot" },
      { t: "    return etree.fromstring(xml, parser)" },
    ],
    patched: [
      { t: "from defusedxml.lxml import fromstring", mark: "add" },
      { t: "" },
      { t: "def parse_saml_assertion(xml: bytes):" },
      { t: '    """Parse a SAML assertion from an identity provider."""' },
      { t: "    return fromstring(xml)  # DTDs + external entities forbidden", mark: "add" },
    ],
  },
  {
    id: "cmdi",
    cwe: "CWE-78",
    severity: "HIGH",
    title: "OS command injection",
    file: "samples/command_injection/app.py",
    impact:
      "shell=True hands the string to the system shell, so input containing ; | && or $() chains arbitrary commands that run with the application's privileges.",
    realWorld:
      "A perennial OWASP top-tier risk — and the exact case VAYU patches end-to-end in the live demo, from Semgrep finding to a verified, signed fix.",
    whySubtle:
      "It works perfectly for well-behaved input and every happy-path test passes. shell=True only betrays you the moment the input carries a shell metacharacter.",
    flagged: "subprocess.run(..., shell=True) with untrusted input",
    vulnerable: [
      { t: "import subprocess" },
      { t: "" },
      { t: "def run_user_command(command: str) -> None:" },
      { t: "    subprocess.run(command, shell=True, check=False)", mark: "hot" },
    ],
    patched: [
      { t: "import subprocess" },
      { t: "" },
      { t: "def run_user_command(command: str) -> None:" },
      { t: "    subprocess.run(command.split(), check=False)  # argv, no shell", mark: "add" },
    ],
  },
];
