<script module>
  import { helper } from 'module-only-pkg';
</script>

<script>
  import vulnLib from 'vuln-lib';
  console.log(vulnLib, helper);
</script>

<p>Both a module and an instance script block</p>
